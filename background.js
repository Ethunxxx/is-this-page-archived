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

const cache = new Map();

function isCheckableUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
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
    // 4xx: treat as "no snapshot" (cacheable). 5xx: treat as a transient
    // failure so the caller can skip caching and retry next visit.
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

  const cached = cache.get(url);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    await applyResultIfStillCurrent(tabId, url, cached.value);
    return;
  }

  setBadgeLoading(tabId);

  const [archiveSettled, waybackSettled] = await Promise.allSettled([
    checkArchiveToday(url),
    checkWayback(url),
  ]);

  const archiveToday = archiveSettled.status === "fulfilled" ? archiveSettled.value : null;
  const wayback = waybackSettled.status === "fulfilled" ? waybackSettled.value : null;
  const archived = !!(archiveToday || wayback);
  const result = { archived, archiveToday, wayback, pageUrl: url };

  // If both upstream checks errored, surface that to the popup instead of
  // pretending we know there's no archive.
  if (
    archiveSettled.status === "rejected" &&
    waybackSettled.status === "rejected"
  ) {
    result.error = true;
  }

  // Only cache when both checks completed cleanly. A transient outage
  // shouldn't poison the cache for the rest of the service-worker lifetime.
  if (
    archiveSettled.status === "fulfilled" &&
    waybackSettled.status === "fulfilled"
  ) {
    cache.set(url, { value: result, cachedAt: Date.now() });
    pruneCache();
  }

  await applyResultIfStillCurrent(tabId, url, result);
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
    chrome.action.setBadgeText({ text: "✓", tabId });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    chrome.action.setBadgeTextColor({ color: "#FFFFFF", tabId });
  } else {
    clearBadge(tabId);
  }
  storeResult(tabId, result);
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: "", tabId });
}

function setBadgeLoading(tabId) {
  chrome.action.setBadgeText({ text: "…", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#8B8C89", tabId });
  chrome.action.setBadgeTextColor({ color: "#FFFFFF", tabId });
}

function storeResult(tabId, result) {
  const data = {};
  data[`tab_${tabId}`] = result;
  chrome.storage.session.set(data);
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
    const cached = cache.get(tab.url);
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
  chrome.storage.session.remove(`tab_${tabId}`);
});

chrome.runtime.onMessage.addListener((msg) => {
  // The popup calls this after the user clicks a "Save to ..." link so
  // the next visit re-checks the archive instead of hitting the cached
  // "not archived" result.
  if (msg && msg.type === "invalidate" && typeof msg.url === "string") {
    cache.delete(msg.url);
  }
});

function pruneCache() {
  if (cache.size > 500) {
    const entries = [...cache.entries()];
    entries.slice(0, 250).forEach(([key]) => cache.delete(key));
  }
}
