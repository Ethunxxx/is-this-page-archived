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
const CACHE_TTL_MS = 60 * 60 * 1000;
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

function addLookupCandidate(candidates, candidate) {
  if (!candidates.some((existing) => normalizeUrl(existing) === normalizeUrl(candidate))) {
    candidates.push(candidate);
  }
}

function lookupCandidates(url) {
  const candidates = [url];
  const stripped = stripTrackingParams(url);
  addLookupCandidate(candidates, stripped);
  addLookupCandidate(candidates, stripSubstackDecorationParams(stripped));
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

async function checkArchiveToday(url) {
  let lastError = null;
  let sawReachableHost = false;
  for (const host of ARCHIVE_TODAY_TIMEMAP_HOSTS) {
    try {
      const result = await fetchArchiveTodayTimemap(url, host);
      sawReachableHost = true;
      if (result) return result;
    } catch (err) {
      lastError = err;
    }
  }
  if (sawReachableHost) return null;
  throw lastError || new Error("archive.today unavailable");
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
    const resp = await fetch(
      `https://${host}/timemap/${encodeURI(url)}`,
      { signal }
    );
    clearTimer();
    // 408/425/429: rate-limit / try-again — transient. 5xx: transient.
    // Other 4xx: treat as "no snapshot" (cacheable).
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw new Error(`archive.today HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw new Error(`archive.today HTTP ${resp.status}`);

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
    throw err;
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
  const target = stripTrackingParams(url);

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
    const resp = await fetch(`https://${host}/${encodeURI(prefixBase)}*`, { signal });
    clearTimer();
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw new Error(`archive.today search HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw new Error(`archive.today search HTTP ${resp.status}`);

    const html = await resp.text();
    return oldestSamePageArchivedUrl(html, target);
  } catch (err) {
    clearTimer();
    throw err;
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
    if (!urlsMatch(stripTrackingParams(original), target)) continue;
    // Rows are listed newest→oldest, so the last match is the oldest snapshot.
    oldest = original;
  }
  return oldest;
}

async function checkWayback(url) {
  const fallback = checkWaybackAvailable(url).catch(() => null);
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
      throw new Error(`wayback HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw new Error(`wayback HTTP ${resp.status}`);

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
    throw err;
  }
}

async function checkWaybackAvailable(url) {
  const { signal, clearTimer } = makeAbortable();
  try {
    const params = new URLSearchParams({ url });
    const resp = await fetch(`${WAYBACK_AVAILABLE_API}?${params}`, { signal });
    clearTimer();
    if (resp.status === 408 || resp.status === 425 || resp.status === 429) {
      throw new Error(`wayback availability HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw new Error(`wayback availability HTTP ${resp.status}`);

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
    throw err;
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
  const target = stripTrackingParams(url);

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
      throw new Error(`wayback prefix HTTP ${resp.status}`);
    }
    if (resp.status >= 400 && resp.status < 500) return null;
    if (!resp.ok) throw new Error(`wayback prefix HTTP ${resp.status}`);

    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    // Keep only captures that are the same page once junk params are stripped,
    // then take the oldest. This rejects sibling paths (…-real-moat-2/) and
    // genuinely different pages (?id=999) that the prefix match also returns.
    let best = null;
    for (const row of data.slice(1)) {
      const [timestamp, original] = row;
      if (!timestamp || !original) continue;
      if (!urlsMatch(stripTrackingParams(original), target)) continue;
      if (!best || timestamp < best.timestamp) best = { timestamp, original };
    }
    if (!best) return null;

    return {
      url: `https://web.archive.org/web/${best.timestamp}/${best.original}`,
      datetime: formatWaybackTimestamp(best.timestamp),
    };
  } catch (err) {
    clearTimer();
    throw err;
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
  let cacheable = true;
  let result = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLastCandidate = i === candidates.length - 1;
    const checked = await fetchCandidate(candidate, (candidateResult) => {
      // Progress from a later URL candidate should preserve snapshots already
      // found on earlier candidates. If more fallbacks remain, keep missing
      // services pending so the popup does not finalize too early.
      const mergedProgress = mergeCandidateResults(result, candidateResult);
      const progressResult =
        !isLastCandidate && !hasAllSnapshots(mergedProgress) && !mergedProgress.error
          ? withPendingFallbackServices(mergedProgress)
          : mergedProgress;
      const progress = withPageMetadata(progressResult, url);
      onProgress(progress);
    });
    cacheable = cacheable && checked.cacheable;
    result = mergeCandidateResults(result, checked);
    if (hasAllSnapshots(result) || checked.error) break;
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
  return {
    ...result,
    checking: true,
    services,
  };
}

function mergeServiceStatus(previous, next, value) {
  if (value) return "found";
  if (previous === "found" || next === "found") return "found";
  if (previous === "checking" || next === "checking") return "checking";
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

  if (services.archiveToday === "error" && services.wayback === "error") {
    merged.error = true;
  }

  return merged;
}

async function fetchCandidate(url, onProgress) {
  const state = {
    archiveToday: null,
    wayback: null,
    services: {
      archiveToday: "checking",
      wayback: "checking",
    },
  };

  const publish = () => onProgress(candidateResult(state));
  const archiveToday = settleService("archiveToday", checkArchiveToday(url), state, publish);
  const wayback = settleService("wayback", checkWayback(url), state, publish);
  await Promise.all([archiveToday, wayback]);

  return candidateResult(state);
}

async function settleService(service, promise, state, publish) {
  try {
    const value = await promise;
    state[service] = value;
    state.services[service] = value ? "found" : "not_found";
  } catch {
    state.services[service] = "error";
  } finally {
    publish();
  }
}

function candidateResult(state) {
  const archived = !!(state.archiveToday || state.wayback);
  const checking = Object.values(state.services).includes("checking");
  const cacheable = !Object.values(state.services).includes("error");
  const result = {
    archived,
    archiveToday: state.archiveToday,
    wayback: state.wayback,
    checking,
    cacheable,
    services: { ...state.services },
  };

  // If both upstream checks errored, surface that to the popup instead of
  // pretending we know there's no archive.
  if (
    state.services.archiveToday === "error" &&
    state.services.wayback === "error"
  ) {
    result.error = true;
  }

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
});

async function searchArchiveTodayVariants(url, tabId) {
  if (!isCheckableUrl(url) || isUserIgnored(url)) return null;
  const memento = await checkArchiveTodayPrefix(url).catch(() => null);
  // Await the merge so the in-memory cache write completes before the message
  // handler resolves — otherwise the worker can go idle after sendResponse and
  // drop the badge/cache update.
  if (memento) await applyArchiveTodayVariant(tabId, url, memento);
  return memento;
}

// Fold a variant snapshot into the cached + stored result so the badge flips to
// "archived" and a reopened popup shows it without re-running the search.
async function applyArchiveTodayVariant(tabId, url, memento) {
  const stored = await getStoredTabResult(tabId).catch(() => null);
  const base =
    stored && storedResultApplies(stored, url)
      ? stored
      : cacheGet(url)?.value || { pageUrl: url, services: {} };
  const merged = mergeArchiveTodayMemento(base, memento, url);
  cacheSet(url, { value: merged, cachedAt: Date.now() });
  silent(applyResultIfStillCurrent(tabId, url, merged));
}

function mergeArchiveTodayMemento(result, memento, url) {
  const services = { ...(result.services || {}) };
  services.archiveToday = "found";
  if (!services.wayback) services.wayback = result.wayback ? "found" : "not_found";
  const merged = {
    ...result,
    archived: true,
    archiveToday: memento,
    checking: false,
    services,
    pageUrl: url,
  };
  // We have a snapshot now, so this is no longer an all-services-failed result.
  delete merged.error;
  return merged;
}

function pruneCache() {
  if (cache.size > 500) {
    const entries = [...cache.entries()];
    entries.slice(0, 250).forEach(([key]) => cache.delete(key));
  }
}
