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
  "archive.today",
  "archive.ph",
  "archive.is",
  "archive.md",
];
const CDX_API = "https://web.archive.org/cdx/search/cdx";
const BADGE_COLOR = "#274C77";
const BADGE_NOT_ARCHIVED_COLOR = "#6096BA";
const BADGE_CHECKING_COLOR = "#8B8C89";
const BADGE_ERROR_COLOR = "#C1121F";
const BADGE_TEXT_COLOR = "#FFFFFF";
const FETCH_TIMEOUT_MS = 10000;
const ARCHIVE_TODAY_FETCH_TIMEOUT_MS = 5000;
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
  let lastError = null;
  for (const host of ARCHIVE_TODAY_TIMEMAP_HOSTS) {
    try {
      return await fetchArchiveTodayTimemap(url, host);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("archive.today unavailable");
}

async function fetchArchiveTodayTimemap(url, host) {
  const { signal, clearTimer } = makeAbortable(ARCHIVE_TODAY_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://${host}/timemap/${encodeURIComponent(url)}`,
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

  // User asked us not to check this site — skip all network calls and let the
  // popup render its "checks disabled" state.
  if (isUserIgnored(url)) {
    clearBadge(tabId);
    storeResult(tabId, { ignored: true, pageUrl: url });
    return;
  }

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
      const progress = withPageMetadata(candidateResult, url);
      // If the exact URL missed and we still have the stripped tracking-param
      // fallback to try, don't briefly flash a final "not archived" state.
      if (!isLastCandidate && !progress.checking && !progress.archived && !progress.error) {
        return;
      }
      onProgress(progress);
    });
    cacheable = cacheable && checked.cacheable;
    result = withPageMetadata(checked, url);
    if (checked.error) result.error = true;
    if (checked.archived || checked.error) break;
  }

  if (cacheable) {
    cacheSet(url, { value: result, cachedAt: Date.now() });
  }

  return result;
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

function setBadgeLoading(tabId, url) {
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
