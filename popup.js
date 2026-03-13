const ARCHIVE_TODAY = "https://archive.ph";
const WAYBACK_SAVE = "https://web.archive.org/save/";

const stateLoading = document.getElementById("state-loading");
const stateArchived = document.getElementById("state-archived");
const stateNotArchived = document.getElementById("state-not-archived");
const stateError = document.getElementById("state-error");
const archivedDate = document.getElementById("archived-date");
const btnView = document.getElementById("btn-view");
const linkArchiveToday = document.getElementById("link-archive-today");
const linkSaveWayback = document.getElementById("link-save-wayback");
const linkSaveArchive = document.getElementById("link-save-archive");

function showState(el) {
  [stateLoading, stateArchived, stateNotArchived, stateError].forEach(
    (s) => s.classList.add("hidden")
  );
  el.classList.remove("hidden");
}

function formatTimestamp(ts) {
  if (!ts || ts.length < 8) return "";
  const y = ts.slice(0, 4);
  const m = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  return `Oldest snapshot: ${y}-${m}-${d}`;
}

function openUrl(url) {
  chrome.tabs.create({ url });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const key = `tab_${tab.id}`;
  const data = await chrome.storage.session.get(key);
  const result = data[key];

  if (!result) {
    showState(stateLoading);
    pollForResult(key, tab.url);
    return;
  }

  renderResult(result, tab.url);
}

function renderResult(result, pageUrl) {
  if (result.error) {
    showState(stateError);
    return;
  }

  if (result.archived) {
    archivedDate.textContent = formatTimestamp(result.timestamp);
    btnView.addEventListener("click", () => openUrl(result.waybackUrl));
    linkArchiveToday.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(`${ARCHIVE_TODAY}/oldest/${pageUrl}`);
    });
    showState(stateArchived);
  } else {
    linkSaveWayback.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(WAYBACK_SAVE + pageUrl);
    });
    linkSaveArchive.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(`${ARCHIVE_TODAY}/?url=${encodeURIComponent(pageUrl)}`);
    });
    showState(stateNotArchived);
  }
}

function pollForResult(key, pageUrl, attempts = 0) {
  if (attempts > 20) {
    showState(stateError);
    return;
  }

  setTimeout(async () => {
    const data = await chrome.storage.session.get(key);
    const result = data[key];
    if (result) {
      renderResult(result, pageUrl);
    } else {
      pollForResult(key, pageUrl, attempts + 1);
    }
  }, 500);
}

init();
