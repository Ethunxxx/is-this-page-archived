const CDX_API = "https://web.archive.org/cdx/search/cdx";
const BADGE_COLOR = "#274C77";
const FETCH_TIMEOUT_MS = 10000;

const cache = new Map();

function isCheckableUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
}

async function checkArchive(url, tabId) {
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const params = new URLSearchParams({
      url: url,
      output: "json",
      limit: "1",
      fl: "timestamp,original",
      sort: "oldest",
    });

    const response = await fetch(`${CDX_API}?${params}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const hasSnapshot = Array.isArray(data) && data.length > 1;

    let result;
    if (hasSnapshot) {
      const [timestamp, original] = data[1];
      const waybackUrl = `https://web.archive.org/web/${timestamp}/${original}`;
      result = {
        archived: true,
        waybackUrl,
        timestamp,
        original,
        pageUrl: url,
      };
    } else {
      result = { archived: false, pageUrl: url };
    }

    cache.set(url, result);
    pruneCache();
    applyResult(tabId, result);
  } catch (e) {
    clearBadge(tabId);
    storeResult(tabId, { archived: false, error: true, pageUrl: url });
  }
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
    checkArchive(url, tabId);
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
