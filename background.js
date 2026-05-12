const ARCHIVE_TODAY_TIMEMAP = "https://archive.ph/timemap/";
const CDX_API = "https://web.archive.org/cdx/search/cdx";
const BADGE_COLOR = "#274C77";
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const ARCHIVE_TODAY_HOSTS = new Set([
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.md",
]);
const TRACKING_QUERY_PARAMS = new Set([
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "referrer",
  "source",
  "wbraid",
  "yclid",
]);

const cache = new Map();
const inflight = new Map();

function silent(promise) {
  if (promise && typeof promise.catch === "function") promise.catch(() => {});
}

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".intranet") ||
    h.endsWith(".lan") ||
    h.endsWith(".test") ||
    h.endsWith(".example") ||
    h.endsWith(".invalid")
  ) {
    return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) {
    return true;
  }
  const ip = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const a = Number(ip[1]);
    const b = Number(ip[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function isCheckableUrl(url) {
  if (!url) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  try {
    return !isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
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

function makeAbortable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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

function isTrackingParamName(name) {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(normalized);
}

function stripTrackingParams(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.search) return url;

    const namesToRemove = new Set();
    for (const [name] of parsed.searchParams) {
      if (isTrackingParamName(name)) namesToRemove.add(name);
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

function lookupCandidates(url) {
  const candidates = [url];
  const stripped = stripTrackingParams(url);
  if (normalizeUrl(stripped) !== normalizeUrl(url)) {
    candidates.push(stripped);
  }
  return candidates;
}

function extractOriginalFromMementoUrl(mementoUrl) {
  // archive.today mementos have the form proto://host/<timestamp>/<original>.
  // Anchor the parse so a stray https:// in the host or timestamp segment
  // can't trick us into accepting the wrong URL.
  const m = mementoUrl.match(/^https?:\/\/[^/]+\/[^/]+\/(https?:\/\/.+)$/);
  return m ? m[1] : null;
}

function isArchiveTodayHost(urlStr) {
  try {
    return ARCHIVE_TODAY_HOSTS.has(new URL(urlStr).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function checkArchiveToday(url) {
  const { signal, clearTimer } = makeAbortable();
  try {
    const resp = await fetch(ARCHIVE_TODAY_TIMEMAP + encodeURIComponent(url), { signal });
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

    return firstMemento;
  } catch (err) {
    clearTimer();
    throw err;
  }
}

async function checkWayback(url) {
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

function formatWaybackTimestamp(ts) {
  if (!ts || ts.length < 14) return ts;
  const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const t = `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
  const date = new Date(`${d}T${t}Z`);
  return isNaN(date.getTime()) ? ts : date.toUTCString();
}

async function checkBoth(url, tabId) {
  if (!isCheckableUrl(url)) {
    clearBadge(tabId);
    storeResult(tabId, null);
    return;
  }

  const cached = cacheGet(url);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    await applyResultIfStillCurrent(tabId, url, cached.value);
    return;
  }

  setBadgeLoading(tabId);

  // Share a single in-flight fetch across concurrent callers asking about
  // the same (normalized) URL — e.g. two tabs on the same page.
  const key = cacheKey(url);
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchBoth(url).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const result = await pending;

  await applyResultIfStillCurrent(tabId, url, result);
}

async function fetchBoth(url) {
  const candidates = lookupCandidates(url);
  let cacheable = true;
  let result = null;

  for (const candidate of candidates) {
    const checked = await fetchCandidate(candidate);
    cacheable = cacheable && checked.cacheable;
    result = {
      archived: checked.archived,
      archiveToday: checked.archiveToday,
      wayback: checked.wayback,
      pageUrl: url,
      checkedAt: Date.now(),
    };
    if (checked.error) result.error = true;
    if (checked.archived || checked.error) break;
  }

  if (cacheable) {
    cacheSet(url, { value: result, cachedAt: Date.now() });
  }

  return result;
}

async function fetchCandidate(url) {
  const [archiveSettled, waybackSettled] = await Promise.allSettled([
    checkArchiveToday(url),
    checkWayback(url),
  ]);

  const archiveToday = archiveSettled.status === "fulfilled" ? archiveSettled.value : null;
  const wayback = waybackSettled.status === "fulfilled" ? waybackSettled.value : null;
  const archived = !!(archiveToday || wayback);
  const cacheable =
    archiveSettled.status === "fulfilled" &&
    waybackSettled.status === "fulfilled";
  const result = { archived, archiveToday, wayback, cacheable };

  // If both upstream checks errored, surface that to the popup instead of
  // pretending we know there's no archive.
  if (
    archiveSettled.status === "rejected" &&
    waybackSettled.status === "rejected"
  ) {
    result.error = true;
  }

  return result;
}

async function applyResultIfStillCurrent(tabId, url, result) {
  // Tab may have navigated to a different URL while our fetches were in
  // flight. Don't paint stale results onto the current page.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !urlsMatch(tab.url, url)) return;
  applyResult(tabId, result);
}

function applyResult(tabId, result) {
  if (result && result.archived) {
    silent(chrome.action.setBadgeText({ text: "✓", tabId }));
    silent(chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }));
    silent(chrome.action.setBadgeTextColor({ color: "#FFFFFF", tabId }));
  } else {
    clearBadge(tabId);
  }
  storeResult(tabId, result);
}

function clearBadge(tabId) {
  silent(chrome.action.setBadgeText({ text: "", tabId }));
}

function setBadgeLoading(tabId) {
  silent(chrome.action.setBadgeText({ text: "…", tabId }));
  silent(chrome.action.setBadgeBackgroundColor({ color: "#8B8C89", tabId }));
  silent(chrome.action.setBadgeTextColor({ color: "#FFFFFF", tabId }));
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
  if (changeInfo.status === "complete" && tab.url) {
    debouncedCheck(tab.url, tabId);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url) return;
    const cached = cacheGet(tab.url);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      applyResult(tab.id, cached.value);
    } else {
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

chrome.runtime.onMessage.addListener((msg) => {
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
  }
});

function pruneCache() {
  if (cache.size > 500) {
    const entries = [...cache.entries()];
    entries.slice(0, 250).forEach(([key]) => cache.delete(key));
  }
}
