const ARCHIVE_TODAY = "https://archive.ph";
const WAYBACK_SAVE = "https://web.archive.org/save/";

const stateLoading = document.getElementById("state-loading");
const stateArchived = document.getElementById("state-archived");
const stateNotArchived = document.getElementById("state-not-archived");
const stateNa = document.getElementById("state-na");
const stateError = document.getElementById("state-error");
const resultsList = document.getElementById("results-list");
const linkSaveArchive = document.getElementById("link-save-archive");
const linkSaveWayback = document.getElementById("link-save-wayback");

function showState(el) {
  [stateLoading, stateArchived, stateNotArchived, stateNa, stateError].forEach(
    (s) => s.classList.add("hidden")
  );
  el.classList.remove("hidden");
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

function formatDatetime(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (isNaN(d.getTime())) return dt;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function openUrl(url) {
  chrome.tabs.create({ url });
}

function createResultRow(serviceName, datetime, url) {
  const row = document.createElement("div");
  row.className = "result-row";

  const info = document.createElement("div");
  info.className = "result-info";

  const name = document.createElement("div");
  name.className = "result-service";
  name.textContent = serviceName;
  info.appendChild(name);

  if (datetime) {
    const date = document.createElement("div");
    date.className = "result-date";
    date.textContent = formatDatetime(datetime);
    info.appendChild(date);
  }

  const btn = document.createElement("button");
  btn.className = "btn-open";
  btn.textContent = "Open";
  btn.addEventListener("click", () => openUrl(url));

  row.appendChild(info);
  row.appendChild(btn);
  return row;
}

let activeCheck = null;
let saveLinksWired = false;

function performCheck(tab, { force }) {
  // Tear down any previous check so a Recheck click can't double-listen.
  if (activeCheck) activeCheck.cancel();

  const key = `tab_${tab.id}`;
  const me = Symbol("check");
  let resolved = false;
  let timeoutId = null;
  const teardown = () => {
    if (resolved) return;
    resolved = true;
    chrome.storage.onChanged.removeListener(onChange);
    if (timeoutId) clearTimeout(timeoutId);
  };
  const finalize = (result) => {
    if (resolved) return;
    teardown();
    if (activeCheck && activeCheck.id === me) activeCheck = null;
    if (result) renderResult(result);
    else showState(stateError);
  };
  const onChange = (changes, area) => {
    if (area !== "session") return;
    const change = changes[key];
    // Fire on any newValue, including null — a null write means the tab
    // moved to a non-checkable URL, which finalize() resolves to error.
    if (change && "newValue" in change) finalize(change.newValue);
  };
  // cancel tears down silently — a superseding Recheck shouldn't flash
  // the error state on its way to showing the new loading state.
  activeCheck = { id: me, cancel: teardown };
  chrome.storage.onChanged.addListener(onChange);

  const startNetworkCheck = () => {
    if (resolved) return;
    showState(stateLoading);
    // Tell the service worker to run the check. Without this, a cold-
    // respawned SW with no pending tab event would never check this tab
    // and the popup would just sit on the loading state until the 12s
    // timeout. The force flag is only set by the Recheck button.
    chrome.runtime
      .sendMessage({ type: "check", tabId: tab.id, url: tab.url, force: !!force })
      .catch(() => {});
    timeoutId = setTimeout(() => finalize(null), 12000);
  };

  if (force) {
    startNetworkCheck();
    return;
  }

  chrome.storage.session.get(key).then((data) => {
    if (resolved) return;
    if (data[key]) finalize(data[key]);
    else startNetworkCheck();
  });
}

function wireRecheck(tab) {
  document.querySelectorAll(".btn-recheck").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      performCheck(tab, { force: true });
    });
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showState(stateError);
    return;
  }

  if (!isCheckableUrl(tab.url)) {
    showState(stateNa);
    return;
  }

  wireRecheck(tab);
  performCheck(tab, { force: false });
}

function renderResult(result) {
  if (result.error) {
    showState(stateError);
    return;
  }
  if (!result.archived && !result.archiveToday && !result.wayback) {
    if (result.pageUrl && !saveLinksWired) {
      saveLinksWired = true;
      const pageUrl = result.pageUrl;
      const invalidate = () => {
        chrome.runtime
          .sendMessage({ type: "invalidate", url: pageUrl })
          .catch(() => {});
      };
      linkSaveArchive.addEventListener("click", (e) => {
        e.preventDefault();
        invalidate();
        openUrl(`${ARCHIVE_TODAY}/?url=${encodeURIComponent(pageUrl)}`);
      });
      linkSaveWayback.addEventListener("click", (e) => {
        e.preventDefault();
        invalidate();
        openUrl(WAYBACK_SAVE + encodeURIComponent(pageUrl));
      });
    }
    showState(stateNotArchived);
    return;
  }

  resultsList.innerHTML = "";

  if (result.archiveToday) {
    resultsList.appendChild(
      createResultRow("archive.today", result.archiveToday.datetime, result.archiveToday.url)
    );
  }

  if (result.wayback) {
    resultsList.appendChild(
      createResultRow("Wayback Machine", result.wayback.datetime, result.wayback.url)
    );
  }

  showState(stateArchived);
}

init();
