const ARCHIVE_TODAY_TIMEMAP = "https://archive.ph/timemap/";
const CDX_API = "https://web.archive.org/cdx/search/cdx";
const BADGE_COLOR = "#274C77";
const FETCH_TIMEOUT_MS = 10000;

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
  const m = mementoUrl.match(/\/(https?:\/\/.+)$/);
  return m ? m[1] : null;
}

async function checkArchiveToday(url) {
  const { signal, clearTimer } = makeAbortable();
  try {
    const resp = await fetch(ARCHIVE_TODAY_TIMEMAP + url, { signal });
    clearTimer();
    if (!resp.ok) return null;

    const text = await resp.text();

    // archive.today's timemap can return mementos for a different URL
    // than the one requested (typically the host root) when no exact
    // match exists. Per RFC 7089 the response advertises the URL it is
    // really about via rel="original"; reject anything that doesn't match.
    const originalMatch = text.match(/<([^>]+)>;\s*rel="original"/);
    if (originalMatch && !urlsMatch(originalMatch[1], url)) return null;

    const firstMatch = text.match(
      /<([^>]+)>;\s*rel="first memento";\s*datetime="([^"]+)"/
    );
    if (!firstMatch) return null;

    // Defence in depth: confirm the memento URL itself embeds the URL
    // we asked for, in case the rel="original" line is missing.
    const embedded = extractOriginalFromMementoUrl(firstMatch[1]);
    if (embedded && !urlsMatch(embedded, url)) return null;

    return { url: firstMatch[1], datetime: firstMatch[2] };
  } catch {
    clearTimer();
    return null;
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
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    const [timestamp, original] = data[1];
    if (!urlsMatch(original, url)) return null;

    return {
      url: `https://web.archive.org/web/${timestamp}/${original}`,
      datetime: formatWaybackTimestamp(timestamp),
    };
  } catch {
    clearTimer();
    return null;
  }
}

function formatWaybackTimestamp(ts) {
  if (!ts || ts.length < 14) return ts;
  const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const t = `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
  return new Date(`${d}T${t}Z`).toUTCString();
}

async function checkBoth(url, tabId) {
  if (!isCheckableUrl(url)) {
    clearBadge(tabId);
    storeResult(tabId, null);
    return;
  }

  const cached = cache.get(url);
  if (cached) {
    applyResult(tabId, cached);
    return;
  }

  setBadgeLoading(tabId);

  const [archiveToday, wayback] = await Promise.all([
    checkArchiveToday(url),
    checkWayback(url),
  ]);

  const archived = !!(archiveToday || wayback);
  const result = { archived, archiveToday, wayback, pageUrl: url };

  cache.set(url, result);
  pruneCache();
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
    if (tab.url) {
      const cached = cache.get(tab.url);
      if (cached) {
        applyResult(tab.id, cached);
      } else {
        debouncedCheck(tab.url, tab.id);
      }
    }
  } catch (e) {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab_${tabId}`);
  debounceTimers.delete(tabId);
});

function pruneCache() {
  if (cache.size > 500) {
    const entries = [...cache.entries()];
    entries.slice(0, 250).forEach(([key]) => cache.delete(key));
  }
}
