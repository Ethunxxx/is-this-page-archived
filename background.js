import { ARCHIVE_TODAY_HOSTS, isCheckableUrl, matchesIgnoreRules } from "./url-policy.js";

const IGNORE_STORAGE_KEY = "ignoredSites";
let userIgnore = { hosts: [], domains: [] };

function normalizeIgnoreRules(raw) {
  return {
    hosts: Array.isArray(raw?.hosts) ? raw.hosts : [],
    domains: Array.isArray(raw?.domains) ? raw.domains : [],
  };
}

silent(
  chrome.storage.local.get(IGNORE_STORAGE_KEY).then((data) => {
    userIgnore = normalizeIgnoreRules(data[IGNORE_STORAGE_KEY]);
  })
);

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isUserIgnored(url) {
  const host = hostnameOf(url);
  return host ? matchesIgnoreRules(host, userIgnore) : false;
}

const ARCHIVE_TODAY_TIMEMAP_HOSTS = [
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.md",
];
const CDX_API = "https://web.archive.org/cdx/search/cdx";
const WAYBACK_AVAILABLE_API = "https://archive.org/wayback/available";
const BADGE_COLOR = "#274C77";
const BADGE_NOT_ARCHIVED_COLOR = "#6096BA";
const BADGE_CHECKING_COLOR = "#8B8C89";
const BADGE_ERROR_COLOR = "#C1121F";
const BADGE_UNAVAILABLE_COLOR = "#E08A1E";
const BADGE_TEXT_COLOR = "#FFFFFF";
const ACTIVE_ICON_PATHS = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};
const INACTIVE_ICON_PATHS = {
  16: "icons/icon-gray-16.png",
  32: "icons/icon-gray-32.png",
  48: "icons/icon-gray-48.png",
  128: "icons/icon-gray-128.png",
};
const FETCH_TIMEOUT_MS = 10000;
const ARCHIVE_TODAY_FETCH_TIMEOUT_MS = 5000;
const ARCHIVE_TODAY_MEMENTO_PROBE_TIMEOUT_MS = 2500;
// archive.today sometimes answers 429 with a Google reCAPTCHA page rather than
// a plain rate limit. That needs a human, so it gets its own status and flow
// (see the CAPTCHA section near the end of this file).
const ARCHIVE_TODAY_CAPTCHA_WINDOW = { width: 520, height: 700 };
const ARCHIVE_TODAY_CAPTCHA_SESSION_MAX_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const TRANSIENT_RETRY_BASE_MS = 900;
const TRANSIENT_RETRY_JITTER_MS = 600;
const TRACKING_QUERY_PARAMS = new Set([
  "_ga",
  "_gl",
  "dclid",
  "fbclid",
  "gad_source",
  "gbraid",
  "gclid",
  "gclsrc",
  "igshid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "referrer",
  "source",
  "ttclid",
  "twclid",
  "wbraid",
  "yclid",
]);
const SUBSTACK_DECORATION_QUERY_PARAMS = new Set([
  "isfreemail",
  "post_id",
  "publication_id",
  "r",
  "triedredirect",
]);

const cache = new Map();
const inflight = new Map();

function silent(promise) {
  if (promise && typeof promise.catch === "function") promise.catch(() => {});
}

// Tag an error as transient (HTTP 429/408/425, 5xx, or a timeout) so callers can
// tell "the service is busy, try again" apart from a hard, non-recoverable failure.
function transientError(message) {
  return Object.assign(new Error(message), { transient: true });
}

// archive.today's reCAPTCHA wall: transient in the sense that it clears, but
// only a human can clear it, so it must never be retried blindly.
function captchaError(host, challengeUrl) {
  return Object.assign(new Error(`archive.today CAPTCHA on ${host}`), {
    transient: true,
    captcha: true,
    host,
    challengeUrl,
  });
}

// A fetch aborted by our own timeout surfaces as an AbortError; treat that as
// transient (the service was too slow) rather than a hard error. The timedOut
// flag lets the archive.today mirror cascade tell "slow backend" (shared by
// every alias) apart from a fast per-hostname 429.
function asTransient(err, signal, label) {
  if (err?.transient) return err;
  if (signal?.aborted || err?.name === "AbortError") {
    return Object.assign(transientError(`${label} timed out`), { timedOut: true });
  }
  return err;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFailureStatus(status) {
  return status === "error" || status === "rate_limited" || status === "captcha";
}

// When no snapshot was found, a definitive "Not Archived" requires BOTH services
// to have actually answered. If either was rate-limited, errored, or timed out,
// the result is inconclusive — surface that (any transient failure → "busy, try
// again"; otherwise a hard error) instead of pretending we know it isn't archived.
function applyFailureFlag(result, services) {
  if (result.archived) return;
  const statuses = [services.archiveToday, services.wayback];
  if (statuses.includes("checking")) return; // still in flight — too early to judge
  if (!statuses.some(isFailureStatus)) return; // both answered, no snapshot → genuinely not archived
  if (statuses.includes("rate_limited") || statuses.includes("captcha")) {
    result.unavailable = true;
  } else {
    result.error = true;
  }
}

// Both services are non-functional (errored or rate-limited): no point trying
// more URL candidates, and the popup should settle on an inconclusive verdict.
function bothServicesFailed(services) {
  return isFailureStatus(services.archiveToday) && isFailureStatus(services.wayback);
}

// Retry a check exactly once, and only when it failed transiently. Reserved for
// the fast-failing endpoints (archive.today's timemap, Wayback's "available"
// fallback); never the slow CDX call, where a second 10s wait would blow the
// popup's time budget. The short jittered backoff avoids instantly re-hitting a
// host that just rate-limited us, and keeps concurrent tabs from syncing up.
async function withTransientRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    // A CAPTCHA wall does not clear on its own; retrying just re-fetches it.
    if (!err?.transient || err?.captcha) throw err;
    await wait(TRANSIENT_RETRY_BASE_MS + Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS));
    return await fn();
  }
}

function cacheKey(url) {
  return normalizeUrl(url);
}

function cacheGet(url) {
  const key = cacheKey(url);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  // Touch: re-insert to mark as most recently used so pruneCache evicts
  // cold entries first.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(url, entry) {
  cache.set(cacheKey(url), entry);
  pruneCache();
}

function cacheDelete(url) {
  cache.delete(cacheKey(url));
}

function makeAbortable(timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clearTimer: () => clearTimeout(timer) };
}

function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = parsed.pathname;
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${host}${pathname}${parsed.search}`;
  } catch {
    return String(u).toLowerCase();
  }
}

function urlsMatch(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

function storedResultApplies(result, url) {
  return (
    result &&
    !result.checking &&
    !result.ignored &&
    result.pageUrl &&
    urlsMatch(result.pageUrl, url)
  );
}

async function getStoredTabResult(tabId) {
  const key = `tab_${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key];
}

function isTrackingParamName(name) {
  const normalized = name.toLowerCase();
  // utm_* (analytics) and __readwise* (Readwise Reader decoration, e.g.
  // __readwiseLocation appended to every link opened from Reader) are
  // vendor-namespaced junk added to arbitrary URLs with no effect on page
  // content. Strip the whole family by prefix rather than enumerating each.
  return (
    normalized.startsWith("utm_") ||
    normalized.startsWith("__readwise") ||
    TRACKING_QUERY_PARAMS.has(normalized)
  );
}

function stripQueryParams(url, shouldStrip) {
  try {
    const parsed = new URL(url);
    if (!parsed.search) return url;

    const namesToRemove = new Set();
    for (const [name] of parsed.searchParams) {
      if (shouldStrip(name, parsed)) namesToRemove.add(name);
    }
    if (!namesToRemove.size) return url;

    for (const name of namesToRemove) {
      parsed.searchParams.delete(name);
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function stripTrackingParams(url) {
  return stripQueryParams(url, isTrackingParamName);
}

function hasSubstackDecorationParams(parsed) {
  for (const [name] of parsed.searchParams) {
    if (SUBSTACK_DECORATION_QUERY_PARAMS.has(name.toLowerCase())) return true;
  }
  return false;
}

function isLikelySubstackArticleUrl(parsed) {
  return parsed.pathname.startsWith("/p/") && hasSubstackDecorationParams(parsed);
}

function stripSubstackDecorationParams(url) {
  return stripQueryParams(url, (name, parsed) => {
    if (!isLikelySubstackArticleUrl(parsed)) return false;
    return SUBSTACK_DECORATION_QUERY_PARAMS.has(name.toLowerCase());
  });
}

// The "same-page" identity of a URL: drop both generic tracking params and
// Substack's article-decoration params, so a decorated URL and its clean form
// resolve to the same key. Used both to build the clean lookup candidate and to
// decide whether an archived snapshot saved under some param-variant is really
// the page we're asking about.
function samePageKey(url) {
  return stripSubstackDecorationParams(stripTrackingParams(url));
}

function addLookupCandidate(candidates, candidate) {
  if (!candidates.some((existing) => normalizeUrl(existing) === normalizeUrl(candidate))) {
    candidates.push(candidate);
  }
}

function lookupCandidates(url) {
  const candidates = [url];
  addLookupCandidate(candidates, stripTrackingParams(url));
  addLookupCandidate(candidates, samePageKey(url));
  return candidates;
}

function extractOriginalFromMementoUrl(mementoUrl) {
  // archive.today mementos have the form proto://host/<timestamp>/<original>.
  // Anchor the parse so a stray https:// in the host or timestamp segment
  // can't trick us into accepting the wrong URL.
  const m = mementoUrl.match(/^https?:\/\/[^/]+\/[^/]+\/(https?:\/\/.+)$/);
  return m ? m[1] : null;
}

function extractOriginalFromWaybackUrl(mementoUrl) {
  const m = mementoUrl.match(/^https?:\/\/web\.archive\.org\/web\/[^/]+\/(https?:\/\/.+)$/);
  return m ? m[1] : null;
}

function isArchiveTodayHost(urlStr) {
  try {
    return ARCHIVE_TODAY_HOSTS.has(new URL(urlStr).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function addUrlCandidate(candidates, candidate) {
  if (!candidates.includes(candidate)) candidates.push(candidate);
}

function archiveTodayMementoUrlCandidates(mementoUrl) {
  try {
    const parsed = new URL(mementoUrl);
    if (!ARCHIVE_TODAY_HOSTS.has(parsed.hostname.toLowerCase())) return [mementoUrl];

    const candidates = [];
    for (const host of ARCHIVE_TODAY_TIMEMAP_HOSTS) {
      const candidate = new URL(parsed.href);
      candidate.protocol = "https:";
      candidate.hostname = host;
      addUrlCandidate(candidates, candidate.toString());
    }
    addUrlCandidate(candidates, mementoUrl);
    return candidates;
  } catch {
    return [mementoUrl];
  }
}

async function probeArchiveTodayMementoUrl(url, options) {
  const { signal, clearTimer } = makeAbortable(ARCHIVE_TODAY_MEMENTO_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      credentials: "include",
      signal,
      ...options,
    });
    clearTimer();
    if (resp.body) await resp.body.cancel().catch(() => {});
    return resp.ok;
  } catch {
    clearTimer();
    return false;
  }
}

async function isReachableArchiveTodayMementoUrl(url) {
  return probeArchiveTodayMementoUrl(url, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
  });
}

async function firstReachableArchiveTodayMementoUrl(mementoUrl) {
  for (const candidate of archiveTodayMementoUrlCandidates(mementoUrl)) {
    if (await isReachableArchiveTodayMementoUrl(candidate)) return candidate;
  }
  return mementoUrl;
}

// ---- archive.today mirror preference + CAPTCHA session ----------------------
//
// The aliases share one archive but not one anti-bot policy: a CAPTCHA wall
// can sit on some hostnames and not others, and which ones changes over time.
// So we remember the alias that answered most recently (the next lookup tries
// it first), the alias that most recently served the CAPTCHA (the one the
// solve window opens, so the cookie it clears is the one the lookup sends),
// and the open solve window, if any. It all lives in chrome.storage.session:
// solving a CAPTCHA takes longer than the service worker stays alive for, so
// in-memory state alone would be gone by the time the solve lands. It does
// not survive a browser restart, and does not need to.
const ARCHIVE_TODAY_STATE_KEY = "archiveTodayState";
let archiveTodayState = { preferredHost: null, captchaHost: null, captchaSession: null };
let archiveTodayStateHydrated = null;

// Resolves to the live state object (hydrated from storage once per worker
// life), so a caller always sees writes made since hydration.
async function loadArchiveTodayState() {
  if (!archiveTodayStateHydrated) {
    archiveTodayStateHydrated = chrome.storage.session
      .get(ARCHIVE_TODAY_STATE_KEY)
      .then((data) => {
        const stored = data[ARCHIVE_TODAY_STATE_KEY];
        if (stored) archiveTodayState = { ...archiveTodayState, ...stored };
      })
      .catch(() => {});
  }
  await archiveTodayStateHydrated;
  return archiveTodayState;
}

// Every writer awaits loadArchiveTodayState() first, so a write can't be
// clobbered by the one-time hydration.
function updateArchiveTodayState(patch) {
  archiveTodayState = { ...archiveTodayState, ...patch };
  silent(chrome.storage.session.set({ [ARCHIVE_TODAY_STATE_KEY]: archiveTodayState }));
}

function archiveTodayHostOrder() {
  const preferred = archiveTodayState.preferredHost;
  if (!preferred || !ARCHIVE_TODAY_TIMEMAP_HOSTS.includes(preferred)) {
    return ARCHIVE_TODAY_TIMEMAP_HOSTS;
  }
  return [preferred, ...ARCHIVE_TODAY_TIMEMAP_HOSTS.filter((h) => h !== preferred)];
}

function captchaSessionActive(session) {
  return !!session && Date.now() - session.startedAt < ARCHIVE_TODAY_CAPTCHA_SESSION_MAX_MS;
}

async function checkArchiveToday(url) {
  const state = await loadArchiveTodayState();
  // The user is clearing a CAPTCHA in the solve window: stay off the
  // archive.today hosts until that settles, so a background lookup can't
  // collect a fresh challenge cookie and invalidate the one being cleared.
  if (captchaSessionActive(state.captchaSession)) {
    throw captchaError(state.captchaSession.host, state.captchaSession.challengeUrl);
  }
  let lastError = null;
  let captcha = null;
  for (const host of archiveTodayHostOrder()) {
    try {
      // A reachable mirror is authoritative — the hosts share one archive — so
      // its answer (a snapshot or a definitive "none") ends the search. Polling
      // the remaining mirrors would only add load for no new information.
      const memento = await fetchArchiveTodayTimemap(url, host);
      if (archiveTodayState.preferredHost !== host) {
        updateArchiveTodayState({ preferredHost: host });
      }
      return memento;
    } catch (err) {
      lastError = err;
      // The CAPTCHA wall is a per-hostname policy, not shared load: another
      // alias often answers at once, and a walled 429 costs a few hundred ms.
      // Keep going; the CAPTCHA is only the verdict if nothing answers.
      if (err?.captcha) {
        captcha = captcha || err;
        continue;
      }
      // A timeout means the shared backend is slow, which applies to every
      // alias; cascading would just multiply the wait. Stop and report it.
      if (err?.timedOut) break;
      // A plain 429/5xx or connection error is this alias's problem only;
      // another may still answer, so fall through and try the next one.
    }
  }
  if (captcha) {
    if (archiveTodayState.captchaHost !== captcha.host) {
      updateArchiveTodayState({ captchaHost: captcha.host });
    }
    throw captcha;
  }
  throw lastError || transientError("archive.today unavailable");
}

// archive.today's bot wall is a 429 whose body is an HTML page embedding a
// Google reCAPTCHA widget. A plain rate limit has no such body.
async function isArchiveTodayCaptchaResponse(resp) {
  if (resp.status !== 429) return false;
  if (!/text\/html/i.test(resp.headers.get("content-type") || "")) return false;
  const html = await resp.text().catch(() => "");
  return /g-recaptcha|chk_captcha|complete the security check/i.test(html);
}

async function fetchArchiveTodayTimemap(url, host) {
  const { signal, clearTimer } = makeAbortable(ARCHIVE_TODAY_FETCH_TIMEOUT_MS);
  try {
    // The target URL is appended raw after /timemap/, and archive.today matches
    // on its real structure — the query delimiters in particular must stay
    // literal. encodeURIComponent escapes "?"->"%3F" and "="->"%3D", so a URL
    // like ".../?__readwiseLocation=" is seen as a path with no query, matches
    // no memento, and 404s. encodeURI preserves "?", "=", "&", "/" and ":"
    // while still escaping genuinely unsafe characters (spaces, etc.).
    // Cookies must ride along: archive.today keys a cleared CAPTCHA to the
    // cookie it set, and an extension fetch is cross-origin, so it would send
    // none by default. Host permissions exempt these hosts from CORS, so the
    // wildcard Access-Control-Allow-Origin the service sends is not a problem.
    const challengeUrl = archiveTodayChallengeUrl(host, url);
    const resp = await fetch(challengeUrl, { signal, credentials: "include" });
    // A 429 carrying the reCAPTCHA page is a bot wall, not load: it needs a
    // human, so it gets its own status and flow rather than a retry.
    if (await isArchiveTodayCaptchaResponse(resp)) {
      throw captchaError(host, challengeUrl);
    }
    clearTimer();
    // 408/425/429: rate-limit / try-again — transient. 5xx: transient.
    // Other 4xx: treat as "no snapshot" (cacheable).
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw transientError(`archive.today HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw transientError(`archive.today HTTP ${resp.status}`);

    const text = await resp.text();

    // archive.today's timemap can return mementos for a different URL
    // than the one requested (typically the host root) when no exact
    // match exists. Per RFC 7089 the response advertises the URL it is
    // really about via rel="original"; reject anything that doesn't match.
    const originalMatch = text.match(/<([^>]+)>;\s*rel="original"/);
    if (originalMatch && !urlsMatch(originalMatch[1], url)) return null;

    // Parse each "<url>; attrs" entry independently rather than assuming a
    // fixed attribute order. The rel attribute is a space-separated token
    // list (RFC 5988): when a URL has only one snapshot archive.today
    // returns rel="first last memento", so match by token presence.
    let firstMemento = null;
    const entryRe = /<([^>]+)>([^<]*)/g;
    for (const m of text.matchAll(entryRe)) {
      const mementoUrl = m[1];
      const attrs = m[2];
      const relMatch = attrs.match(/rel="([^"]+)"/);
      if (!relMatch) continue;
      const tokens = relMatch[1].split(/\s+/);
      if (!tokens.includes("memento") || !tokens.includes("first")) continue;
      const dtMatch = attrs.match(/datetime="([^"]+)"/);
      if (!dtMatch) continue;
      firstMemento = { url: mementoUrl, datetime: dtMatch[1] };
      break;
    }
    if (!firstMemento) return null;

    // Defence in depth: the memento URL itself must live on an
    // archive.today host AND embed the URL we asked for.
    if (!isArchiveTodayHost(firstMemento.url)) return null;
    const embedded = extractOriginalFromMementoUrl(firstMemento.url);
    if (embedded && !urlsMatch(embedded, url)) return null;

    return {
      ...firstMemento,
      url: await firstReachableArchiveTodayMementoUrl(firstMemento.url),
    };
  } catch (err) {
    clearTimer();
    throw asTransient(err, signal, "archive.today");
  }
}

// archive.today's /timemap/ is byte-exact, so it can't find a snapshot saved
// under a trailing-slash or junk-param variant of the current URL (e.g. the
// page is captured as ".../post/?__readwiseLocation=" but the user is on the
// clean ".../post"). Its wildcard search ("https://host/<url>*") lists every
// snapshot whose URL starts with the prefix and is the only endpoint that can
// surface such variants. That endpoint is aggressively rate-limited, so this
// runs on demand (popup open), never on the background per-navigation sweep.
async function checkArchiveTodayPrefix(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A wildcard on a bare origin ("/") would scan the whole host for no benefit.
  if (parsed.pathname.length <= 1) return null;

  const prefixBase = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  const target = samePageKey(url);

  const discovered = await discoverArchiveTodayVariantUrl(prefixBase, target);
  if (!discovered) return null;

  // Resolve the discovered exact URL through the normal (un-throttled) timemap
  // path: that re-verifies the snapshot and yields a reachable memento URL plus
  // an ISO datetime, reusing all the host-fallback handling in checkArchiveToday.
  return await checkArchiveToday(discovered).catch(() => null);
}

async function discoverArchiveTodayVariantUrl(prefixBase, target) {
  // The hosts mirror one shared archive, so a single reachable host answers for
  // all of them; only fall through to another mirror when one is rate-limited.
  for (const host of ARCHIVE_TODAY_TIMEMAP_HOSTS) {
    try {
      return await fetchArchiveTodayWildcard(prefixBase, target, host);
    } catch {
      // 429 / transient on this mirror — try the next one.
    }
  }
  return null;
}

async function fetchArchiveTodayWildcard(prefixBase, target, host) {
  const { signal, clearTimer } = makeAbortable(ARCHIVE_TODAY_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://${host}/${encodeURI(prefixBase)}*`, {
      signal,
      credentials: "include",
    });
    if (await isArchiveTodayCaptchaResponse(resp)) {
      throw captchaError(host, archiveTodayChallengeUrl(host, prefixBase));
    }
    clearTimer();
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw transientError(`archive.today search HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw transientError(`archive.today search HTTP ${resp.status}`);

    const html = await resp.text();
    return oldestSamePageArchivedUrl(html, target);
  } catch (err) {
    clearTimer();
    throw asTransient(err, signal, "archive.today search");
  }
}

function oldestSamePageArchivedUrl(html, target) {
  // Each result row links the archived ORIGINAL url as
  //   href="https://<archive-host>/<https://original-url>"
  // Pull those out and keep the oldest whose same-page identity (junk query
  // params stripped) matches the page we want. The capture must itself start
  // with http(s), which rejects the page's chrome: the "/<host>/*" prefix
  // example (carries a "*"), bare-host examples, and the favicon/thumb links.
  const re = /href="https?:\/\/[a-z0-9.-]+\/(https?:\/\/[^"]+)"/gi;
  let oldest = null;
  for (const m of html.matchAll(re)) {
    const original = m[1];
    if (original.includes("*")) continue;
    if (!urlsMatch(samePageKey(original), target)) continue;
    // Rows are listed newest→oldest, so the last match is the oldest snapshot.
    oldest = original;
  }
  return oldest;
}

async function checkWayback(url) {
  // The CDX call is the slow, authoritative path; the lightweight "available"
  // API is the fast fallback, so it's the one we retry on a transient blip.
  const fallback = withTransientRetry(() => checkWaybackAvailable(url)).catch(() => null);
  try {
    const exact = await checkWaybackCdx(url);
    if (exact) return exact;
  } catch (err) {
    const fallbackResult = await fallback;
    if (fallbackResult) return fallbackResult;
    throw err;
  }
  // Exact CDX succeeded but found no snapshot for this precise URL. Before
  // concluding "not archived", sweep for a same-page capture that differs only
  // by junk query params — e.g. an archive saved as ?__readwiseLocation= while
  // the user is on the clean URL. Best-effort: a failure here just falls back
  // to the original "no exact snapshot" answer.
  return await checkWaybackPrefix(url).catch(() => null);
}

async function checkWaybackCdx(url) {
  const { signal, clearTimer } = makeAbortable();
  try {
    const params = new URLSearchParams({
      url,
      output: "json",
      limit: "1",
      fl: "timestamp,original",
      sort: "oldest",
    });
    const resp = await fetch(`${CDX_API}?${params}`, { signal });
    clearTimer();
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw transientError(`wayback HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw transientError(`wayback HTTP ${resp.status}`);

    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    const [timestamp, original] = data[1];
    if (!urlsMatch(original, url)) return null;

    return {
      url: `https://web.archive.org/web/${timestamp}/${original}`,
      datetime: formatWaybackTimestamp(timestamp),
    };
  } catch (err) {
    clearTimer();
    throw asTransient(err, signal, "wayback");
  }
}

async function checkWaybackAvailable(url) {
  const { signal, clearTimer } = makeAbortable();
  try {
    const params = new URLSearchParams({ url });
    const resp = await fetch(`${WAYBACK_AVAILABLE_API}?${params}`, { signal });
    clearTimer();
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw transientError(`wayback availability HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw transientError(`wayback availability HTTP ${resp.status}`);

    const data = await resp.json();
    const closest = data?.archived_snapshots?.closest;
    if (!closest?.available || !closest.url || !closest.timestamp) return null;

    const original = extractOriginalFromWaybackUrl(closest.url);
    if (original && !urlsMatch(original, url)) return null;

    return {
      url: closest.url.replace(/^http:\/\//, "https://"),
      datetime: formatWaybackTimestamp(closest.timestamp),
    };
  } catch (err) {
    clearTimer();
    throw asTransient(err, signal, "wayback availability");
  }
}

async function checkWaybackPrefix(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A prefix sweep on a bare origin ("/") would scan the entire host for no
  // real benefit, so require a meaningful path.
  if (parsed.pathname.length <= 1) return null;

  // Match every capture whose path starts here (the trailing slash is dropped
  // so /foo, /foo/, and /foo/?x all match); the same-page filter below rejects
  // the sibling paths and meaningful-param pages this broad match also returns.
  const prefixBase = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  const target = samePageKey(url);

  const { signal, clearTimer } = makeAbortable();
  try {
    const params = new URLSearchParams({
      url: prefixBase,
      matchType: "prefix",
      output: "json",
      fl: "timestamp,original",
      collapse: "urlkey",
      limit: "50",
    });
    const resp = await fetch(`${CDX_API}?${params}`, { signal });
    clearTimer();
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw transientError(`wayback prefix HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw transientError(`wayback prefix HTTP ${resp.status}`);

    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    // Keep only captures that are the same page once junk params are stripped,
    // then take the oldest. This rejects sibling paths (…-real-moat-2/) and
    // genuinely different pages (?id=999) that the prefix match also returns.
    let best = null;
    for (const row of data.slice(1)) {
      const [timestamp, original] = row;
      if (!timestamp || !original) continue;
      if (!urlsMatch(samePageKey(original), target)) continue;
      if (!best || timestamp < best.timestamp) best = { timestamp, original };
    }
    if (!best) return null;

    return {
      url: `https://web.archive.org/web/${best.timestamp}/${best.original}`,
      datetime: formatWaybackTimestamp(best.timestamp),
    };
  } catch (err) {
    clearTimer();
    throw asTransient(err, signal, "wayback prefix");
  }
}

function formatWaybackTimestamp(ts) {
  if (!ts || ts.length < 14) return ts;
  const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const t = `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
  const date = new Date(`${d}T${t}Z`);
  return isNaN(date.getTime()) ? ts : date.toUTCString();
}

async function checkBoth(url, tabId) {
  if (!isCheckableUrl(url)) {
    setInactiveIcon(tabId);
    clearBadge(tabId);
    storeResult(tabId, null);
    return;
  }

  // User asked us not to check this site — skip all network calls and let the
  // popup render its "checks disabled" state.
  if (isUserIgnored(url)) {
    setInactiveIcon(tabId);
    clearBadge(tabId);
    storeResult(tabId, { ignored: true, pageUrl: url });
    return;
  }

  setActiveIcon(tabId);

  const cached = cacheGet(url);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    await applyResultIfStillCurrent(tabId, url, cached.value);
    return;
  }

  // Share a single in-flight fetch across concurrent callers asking about
  // the same (normalized) URL — e.g. two tabs on the same page.
  const key = cacheKey(url);
  let pending = inflight.get(key);
  if (!pending?.latest?.archived) {
    setBadgeLoading(tabId, url);
  }
  if (!pending) {
    pending = startInflightCheck(url, key);
    inflight.set(key, pending);
  }
  const applyProgress = (result) => {
    silent(applyResultIfStillCurrent(tabId, url, result));
  };
  pending.listeners.add(applyProgress);
  if (pending.latest) applyProgress(pending.latest);

  try {
    const result = await pending.promise;
    await applyResultIfStillCurrent(tabId, url, result);
  } finally {
    pending.listeners.delete(applyProgress);
  }
}

function startInflightCheck(url, key) {
  const pending = {
    latest: null,
    listeners: new Set(),
    promise: null,
  };
  const publish = (result) => {
    pending.latest = result;
    pending.listeners.forEach((listener) => listener(result));
  };

  pending.promise = fetchBoth(url, publish).finally(() => inflight.delete(key));
  return pending;
}

async function fetchBoth(url, onProgress = () => {}) {
  const candidates = lookupCandidates(url);
  // archive.today uses a byte-exact timemap, so it only pays to query the URLs a
  // snapshot is plausibly stored under: the page exactly as-is, and its clean
  // canonical form (snapshots are usually saved without tracking/decoration
  // params). Intermediate partly-stripped variants almost never match, so we
  // don't spend requests on a rate-limited host for them — the popup's on-demand
  // wildcard search is the deeper fallback for genuinely unpredictable variants.
  const archiveTodayCandidates = new Set([normalizeUrl(url), normalizeUrl(samePageKey(url))]);
  let cacheable = true;
  let result = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLastCandidate = i === candidates.length - 1;
    // Query archive.today only for the page-identity candidates above, and only
    // until one yields a snapshot; Wayback still runs for every candidate.
    const skipArchiveToday =
      Boolean(result?.archiveToday) ||
      // Once the CAPTCHA wall is up it is up for every candidate; "skipped"
      // defers to the earlier verdict, so the CAPTCHA state survives the merge.
      result?.services?.archiveToday === "captcha" ||
      !archiveTodayCandidates.has(normalizeUrl(candidate));
    const checked = await fetchCandidate(candidate, (candidateResult) => {
      // Progress from a later URL candidate should preserve snapshots already
      // found on earlier candidates. If more fallbacks remain, keep missing
      // services pending so the popup does not finalize too early.
      const mergedProgress = mergeCandidateResults(result, candidateResult);
      const progressResult =
        !isLastCandidate && !hasAllSnapshots(mergedProgress) && !bothServicesFailed(mergedProgress.services)
          ? withPendingFallbackServices(mergedProgress)
          : mergedProgress;
      const progress = withPageMetadata(progressResult, url);
      onProgress(progress);
    }, { skipArchiveToday });
    cacheable = cacheable && checked.cacheable;
    result = mergeCandidateResults(result, checked);
    if (hasAllSnapshots(result) || bothServicesFailed(result.services)) break;
  }

  result = withPageMetadata(result, url);
  if (cacheable) {
    cacheSet(url, { value: result, cachedAt: Date.now() });
  }

  return result;
}

function hasAllSnapshots(result) {
  return !!(result?.archiveToday && result?.wayback);
}

function withPendingFallbackServices(result) {
  const services = { ...result.services };
  if (!result.archiveToday) services.archiveToday = "checking";
  if (!result.wayback) services.wayback = "checking";
  const pending = {
    ...result,
    checking: true,
    services,
  };
  // We've reset the unfinished services to "checking" for the next candidate,
  // so any "both failed" verdict reached so far no longer holds.
  delete pending.error;
  delete pending.unavailable;
  return pending;
}

function mergeServiceStatus(previous, next, value) {
  if (value) return "found";
  // "skipped" means a candidate didn't run this service (tracking-param variants
  // skip archive.today); it must never override the other candidate's real answer.
  if (previous === "skipped") return next;
  if (next === "skipped") return previous;
  if (previous === "found" || next === "found") return "found";
  if (previous === "checking" || next === "checking") return "checking";
  // The CAPTCHA is the one failure the user can act on, so it outranks the rest.
  if (previous === "captcha" || next === "captcha") return "captcha";
  if (previous === "rate_limited" || next === "rate_limited") return "rate_limited";
  if (previous === "error" || next === "error") return "error";
  return "not_found";
}

function mergeCandidateResults(previous, next) {
  if (!previous) {
    return {
      ...next,
      services: { ...next.services },
    };
  }

  const archiveToday = previous.archiveToday || next.archiveToday;
  const wayback = previous.wayback || next.wayback;
  const services = {
    archiveToday: mergeServiceStatus(
      previous.services.archiveToday,
      next.services.archiveToday,
      archiveToday
    ),
    wayback: mergeServiceStatus(previous.services.wayback, next.services.wayback, wayback),
  };
  const merged = {
    archived: !!(archiveToday || wayback),
    archiveToday,
    wayback,
    checking: Object.values(services).includes("checking"),
    cacheable: previous.cacheable && next.cacheable,
    services,
  };

  applyFailureFlag(merged, services);

  return merged;
}

async function fetchCandidate(url, onProgress, { skipArchiveToday = false } = {}) {
  const state = {
    archiveToday: null,
    wayback: null,
    services: {
      // archiveToday may be skipped for this candidate (see fetchBoth's
      // candidate selection). "skipped" defers to whatever a checked candidate
      // reports, so it never overrides another candidate's real answer.
      archiveToday: skipArchiveToday ? "skipped" : "checking",
      wayback: "checking",
    },
  };

  const publish = () => onProgress(candidateResult(state));
  const tasks = [settleService("wayback", checkWayback(url), state, publish)];
  if (skipArchiveToday) {
    publish();
  } else {
    tasks.push(
      settleService("archiveToday", withTransientRetry(() => checkArchiveToday(url)), state, publish)
    );
  }
  await Promise.all(tasks);

  return candidateResult(state);
}

async function settleService(service, promise, state, publish) {
  try {
    const value = await promise;
    state[service] = value;
    state.services[service] = value ? "found" : "not_found";
  } catch (err) {
    // "captcha" is archive.today's bot wall (the popup offers to open it);
    // "rate_limited" is a transient failure (busy / slow / 429) the user can
    // retry; "error" is a hard failure. The popup surfaces them differently.
    state.services[service] = err?.captcha
      ? "captcha"
      : err?.transient
        ? "rate_limited"
        : "error";
  } finally {
    publish();
  }
}

function candidateResult(state) {
  const archived = !!(state.archiveToday || state.wayback);
  const checking = Object.values(state.services).includes("checking");
  const cacheable = !Object.values(state.services).some(isFailureStatus);
  const result = {
    archived,
    archiveToday: state.archiveToday,
    wayback: state.wayback,
    checking,
    cacheable,
    services: { ...state.services },
  };

  applyFailureFlag(result, state.services);

  return result;
}

function withPageMetadata(result, pageUrl) {
  return {
    archived: result.archived,
    archiveToday: result.archiveToday,
    wayback: result.wayback,
    checking: result.checking,
    cacheable: result.cacheable,
    services: result.services,
    pageUrl,
    checkedAt: Date.now(),
    ...(result.error ? { error: true } : {}),
    ...(result.unavailable ? { unavailable: true } : {}),
  };
}

async function applyResultIfStillCurrent(tabId, url, result) {
  // Tab may have navigated to a different URL while our fetches were in
  // flight. Don't paint stale results onto the current page.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !urlsMatch(tab.url, url)) return;
  applyResult(tabId, result);
}

function applyResult(tabId, result) {
  if (result) setActiveIcon(tabId);
  else setInactiveIcon(tabId);

  if (result && result.archived) {
    setBadge(tabId, "✓", BADGE_COLOR);
  } else if (result && result.checking) {
    setBadge(tabId, "?", BADGE_CHECKING_COLOR);
  } else if (result && result.unavailable) {
    setBadge(tabId, "!", BADGE_UNAVAILABLE_COLOR);
  } else if (result && result.error) {
    setBadge(tabId, "✕", BADGE_ERROR_COLOR);
  } else if (result) {
    setBadge(tabId, "✕", BADGE_NOT_ARCHIVED_COLOR);
  } else {
    clearBadge(tabId);
  }
  storeResult(tabId, result);
}

function setBadge(tabId, text, color) {
  silent(chrome.action.setBadgeText({ text, tabId }));
  silent(chrome.action.setBadgeBackgroundColor({ color, tabId }));
  silent(chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR, tabId }));
}

function clearBadge(tabId) {
  silent(chrome.action.setBadgeText({ text: "", tabId }));
}

function setActiveIcon(tabId) {
  setActionIcon(tabId, ACTIVE_ICON_PATHS);
}

function setInactiveIcon(tabId) {
  setActionIcon(tabId, INACTIVE_ICON_PATHS);
}

function setActionIcon(tabId, path) {
  silent(chrome.action.setIcon({ path, tabId }));
}

function setBadgeLoading(tabId, url) {
  setActiveIcon(tabId);
  setBadge(tabId, "?", BADGE_CHECKING_COLOR);
  // Mark in-flight so the popup doesn't render a stale result for this tab
  // while the badge already shows "?".
  storeResult(tabId, { checking: true, pageUrl: url });
}

function storeResult(tabId, result) {
  const data = {};
  data[`tab_${tabId}`] = result;
  silent(chrome.storage.session.set(data));
}

const debounceTimers = new Map();

function debouncedCheck(url, tabId) {
  const existing = debounceTimers.get(tabId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(tabId);
    checkBoth(url, tabId);
  }, 300);
  debounceTimers.set(tabId, timer);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (tab.url) {
    debouncedCheck(tab.url, tabId);
    return;
  }
  setInactiveIcon(tabId);
  clearBadge(tabId);
  storeResult(tabId, null);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url) {
      setInactiveIcon(activeInfo.tabId);
      clearBadge(activeInfo.tabId);
      storeResult(activeInfo.tabId, null);
      return;
    }
    if (!isCheckableUrl(tab.url)) {
      setInactiveIcon(tab.id);
      clearBadge(tab.id);
      storeResult(tab.id, null);
      return;
    }
    if (isUserIgnored(tab.url)) {
      setInactiveIcon(tab.id);
      clearBadge(tab.id);
      storeResult(tab.id, { ignored: true, pageUrl: tab.url });
      return;
    }
    const stored = await getStoredTabResult(tab.id);
    if (storedResultApplies(stored, tab.url)) {
      applyResult(tab.id, stored);
      return;
    }
    const cached = cacheGet(tab.url);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      applyResult(tab.id, cached.value);
    } else {
      setActiveIcon(tab.id);
      debouncedCheck(tab.url, tab.id);
    }
  } catch {
    // Tab may have been removed before we could read it.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = debounceTimers.get(tabId);
  if (pending) clearTimeout(pending);
  debounceTimers.delete(tabId);
  silent(chrome.storage.session.remove(`tab_${tabId}`));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[IGNORE_STORAGE_KEY]) return;
  userIgnore = normalizeIgnoreRules(changes[IGNORE_STORAGE_KEY].newValue);
  // Re-evaluate the active tab in every window so toggling an ignore rule
  // takes effect immediately (badge appears/clears) without a reload.
  chrome.tabs.query({ active: true }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url || !tab.id) continue;
      cacheDelete(tab.url);
      debouncedCheck(tab.url, tab.id);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  // The popup calls "invalidate" after the user clicks a "Save to ..." link
  // so the next visit re-checks instead of hitting the cached "not archived".
  if (msg.type === "invalidate" && typeof msg.url === "string") {
    cacheDelete(msg.url);
    return;
  }
  // The popup calls "check" on open so a cold-respawned service worker
  // doesn't sit idle waiting for an event that won't fire. The force flag
  // is used by the Recheck button to bypass any cached result.
  if (
    msg.type === "check" &&
    typeof msg.url === "string" &&
    typeof msg.tabId === "number"
  ) {
    if (msg.force) cacheDelete(msg.url);
    debouncedCheck(msg.url, msg.tabId);
    return;
  }
  // The popup calls this when archive.today's exact lookup found nothing, to
  // hunt for a snapshot saved under a trailing-slash/junk-param variant via the
  // rate-limited wildcard search. Kept off the background sweep so normal
  // browsing never hammers that endpoint. Async reply → return true.
  if (
    msg.type === "searchArchiveTodayVariants" &&
    typeof msg.url === "string" &&
    typeof msg.tabId === "number"
  ) {
    searchArchiveTodayVariants(msg.url, msg.tabId).then(
      (memento) => sendResponse(memento ? { archiveToday: memento } : null),
      () => sendResponse(null)
    );
    return true;
  }
  // The popup's "Solve" button: open archive.today's CAPTCHA in a small popup
  // window and re-check the page once it is cleared. Async reply → return true.
  if (
    msg.type === "solveArchiveTodayCaptcha" &&
    typeof msg.url === "string" &&
    typeof msg.tabId === "number"
  ) {
    openArchiveTodayCaptcha(msg.url, msg.tabId).then(
      (outcome) => sendResponse(outcome),
      () => sendResponse({ opened: false })
    );
    return true;
  }
});

// ---- archive.today CAPTCHA solve window -------------------------------------
//
// When every alias answers with the reCAPTCHA wall, the popup offers a "Solve"
// button. It opens the walled timemap URL in a small popup window rather than
// a tab: it is a one-off chore, and a window can be closed by us the moment it
// is done. The challenge page rewrites its address to "/" while it waits and,
// once solved, reloads the original timemap URL. We watch for that reload,
// re-run the lookup (now carrying the cleared cookie), and on success close
// the window and re-check the page that triggered it. The session itself is
// persisted with the rest of the archive.today state (see above), because the
// worker will almost certainly be restarted between opening and solving.

let captchaVerifying = false;

function archiveTodayChallengeUrl(host, pageUrl) {
  return `https://${host}/timemap/${encodeURI(pageUrl)}`;
}

async function openArchiveTodayCaptcha(pageUrl, sourceTabId) {
  const state = await loadArchiveTodayState();
  if (state.captchaSession) {
    // One window at a time: bring the existing one forward.
    const focused = await chrome.windows
      .update(state.captchaSession.windowId, { focused: true })
      .catch(() => null);
    if (focused) return { opened: true, reused: true };
    updateArchiveTodayState({ captchaSession: null }); // the window is already gone
  }
  const host = archiveTodayState.captchaHost || archiveTodayHostOrder()[0];
  const challengeUrl = archiveTodayChallengeUrl(host, pageUrl);
  const win = await chrome.windows.create({
    url: challengeUrl,
    type: "popup",
    focused: true,
    ...ARCHIVE_TODAY_CAPTCHA_WINDOW,
  });
  const tab = win?.tabs?.[0];
  if (!tab) return { opened: false };
  updateArchiveTodayState({
    captchaSession: {
      windowId: win.id,
      tabId: tab.id,
      host,
      challengeUrl,
      pageUrl,
      sourceTabId,
      startedAt: Date.now(),
    },
  });
  return { opened: true };
}

async function verifyArchiveTodayCaptchaSolved(session) {
  if (captchaVerifying) return;
  captchaVerifying = true;
  try {
    // Throws the CAPTCHA error while the wall is still up. A snapshot or a
    // definitive "none" both mean it is down.
    await fetchArchiveTodayTimemap(session.pageUrl, session.host);
  } catch {
    return; // still walled (or a blip): wait for the window's next load
  } finally {
    captchaVerifying = false;
  }
  if (archiveTodayState.captchaSession?.windowId !== session.windowId) return;
  updateArchiveTodayState({ captchaSession: null, preferredHost: session.host });
  silent(chrome.windows.remove(session.windowId));
  recheckAfterCaptcha(session);
}

function recheckAfterCaptcha({ pageUrl, sourceTabId }) {
  cacheDelete(pageUrl);
  debouncedCheck(pageUrl, sourceTabId);
}

function isArchiveTodayTimemapUrl(url) {
  return (
    typeof url === "string" &&
    ARCHIVE_TODAY_TIMEMAP_HOSTS.some((host) => url.startsWith(`https://${host}/timemap/`))
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  // Only a load of the timemap URL itself can be the post-solve reload; the
  // waiting challenge page sits on "/".
  if (!isArchiveTodayTimemapUrl(tab.url)) return;
  silent(
    loadArchiveTodayState().then((state) => {
      const session = state.captchaSession;
      if (!session || tabId !== session.tabId) return;
      if (!tab.url.startsWith(`https://${session.host}/timemap/`)) return;
      return verifyArchiveTodayCaptchaSolved(session);
    })
  );
});

chrome.windows.onRemoved.addListener((windowId) => {
  silent(
    loadArchiveTodayState().then((state) => {
      const session = state.captchaSession;
      if (!session || windowId !== session.windowId) return;
      updateArchiveTodayState({ captchaSession: null });
      // Closed by the user. Re-check anyway: if they solved it and we missed
      // the reload this picks it up; if not, the popup offers the CAPTCHA again.
      recheckAfterCaptcha(session);
    })
  );
});

function pruneCache() {
  if (cache.size > 500) {
    const entries = [...cache.entries()];
    entries.slice(0, 250).forEach(([key]) => cache.delete(key));
  }
}
