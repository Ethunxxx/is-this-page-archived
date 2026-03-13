const ARCHIVE_TODAY = "https://archive.ph";
const WAYBACK_SAVE = "https://web.archive.org/save/";

const stateLoading = document.getElementById("state-loading");
const stateArchived = document.getElementById("state-archived");
const stateNotArchived = document.getElementById("state-not-archived");
const stateError = document.getElementById("state-error");
const resultsList = document.getElementById("results-list");
const linkSaveArchive = document.getElementById("link-save-archive");
const linkSaveWayback = document.getElementById("link-save-wayback");

function showState(el) {
  [stateLoading, stateArchived, stateNotArchived, stateError].forEach(
    (s) => s.classList.add("hidden")
  );
  el.classList.remove("hidden");
}

function formatDatetime(dt) {
  if (!dt) return "";
  try {
    const d = new Date(dt);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dt;
  }
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

  renderResult(result);
}

function renderResult(result) {
  if (!result.archived && !result.archiveToday && !result.wayback) {
    if (result.pageUrl) {
      linkSaveArchive.addEventListener("click", (e) => {
        e.preventDefault();
        openUrl(`${ARCHIVE_TODAY}/?url=${encodeURIComponent(result.pageUrl)}`);
      });
      linkSaveWayback.addEventListener("click", (e) => {
        e.preventDefault();
        openUrl(WAYBACK_SAVE + result.pageUrl);
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

function pollForResult(key, pageUrl, attempts = 0) {
  if (attempts > 20) {
    showState(stateError);
    return;
  }

  setTimeout(async () => {
    const data = await chrome.storage.session.get(key);
    const result = data[key];
    if (result) {
      renderResult(result);
    } else {
      pollForResult(key, pageUrl, attempts + 1);
    }
  }, 500);
}

init();
