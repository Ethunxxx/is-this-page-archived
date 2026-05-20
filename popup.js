const ARCHIVE_TODAY = "https://archive.ph";
const WAYBACK_SAVE = "https://web.archive.org/save/";
const ARCHIVE_SERVICE_HOSTS = new Set([
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.md",
  "web.archive.org",
]);
const EXCLUDED_HOSTS = new Set([
  "www.capitaliq.spglobal.com",
  "www.google.com",
  "youtube.com",
  "www.youtube.com",
]);
const EXCLUDED_HOST_SUFFIXES = [
  "mail.google.com",
  "calendar.google.com",
  "maps.google.com",
  "drive.google.com",
];

const stateLoading = document.getElementById("state-loading");
const stateArchived = document.getElementById("state-archived");
const stateNotArchived = document.getElementById("state-not-archived");
const stateNa = document.getElementById("state-na");
const stateError = document.getElementById("state-error");
const resultsList = document.getElementById("results-list");
const linkSaveArchive = document.getElementById("link-save-archive");
const linkSaveWayback = document.getElementById("link-save-wayback");
const loadingMessage = stateLoading.querySelector(".message");
const archivedSubtitle = stateArchived.querySelector(".subtitle");
const DEFAULT_LOADING_MESSAGE = "Checking archives...";
const DEFAULT_ARCHIVED_SUBTITLE = "Oldest snapshots found";
const SERVICE_NAMES = {
  archiveToday: "archive.today",
  wayback: "Wayback Machine",
};

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

function isArchiveServiceHost(hostname) {
  return ARCHIVE_SERVICE_HOSTS.has(hostname.toLowerCase());
}

function isExcludedHost(hostname) {
  const h = hostname.toLowerCase();
  if (EXCLUDED_HOSTS.has(h)) return true;
  return EXCLUDED_HOST_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith("." + suffix)
  );
}

function isCheckableUrl(url) {
  if (!url) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  try {
    const hostname = new URL(url).hostname;
    return (
      !isPrivateHost(hostname) &&
      !isArchiveServiceHost(hostname) &&
      !isExcludedHost(hostname)
    );
  } catch {
    return false;
  }
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

function createStatusRow(serviceName, message) {
  const row = document.createElement("div");
  row.className = "result-row";

  const info = document.createElement("div");
  info.className = "result-info";

  const name = document.createElement("div");
  name.className = "result-service";
  name.textContent = serviceName;
  info.appendChild(name);

  const status = document.createElement("div");
  status.className = "result-date";
  status.textContent = message;
  info.appendChild(status);

  row.appendChild(info);
  return row;
}

function serviceName(service) {
  return SERVICE_NAMES[service] || service;
}

function formatServiceList(services) {
  return services.map(serviceName).join(" and ");
}

function getServiceStatuses(result) {
  if (result.services) return result.services;
  return {
    archiveToday: result.archiveToday ? "found" : result.checking ? "checking" : "not_found",
    wayback: result.wayback ? "found" : result.checking ? "checking" : "not_found",
  };
}

function statusSummary(service, status) {
  const name = serviceName(service);
  if (status === "found") return `${name} found a snapshot`;
  if (status === "not_found") return `${name} did not find a snapshot`;
  if (status === "error") return `${name} could not be reached`;
  return `${name} is still checking`;
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
    // Intermediate writes keep the popup open so final results can still land.
    if (result?.checking) {
      renderResult(result);
      return;
    }
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
  const storedResultApplies = (result) =>
    result &&
    !result.checking &&
    result.pageUrl &&
    urlsMatch(result.pageUrl, tab.url);
  // cancel tears down silently — a superseding Recheck shouldn't flash
  // the error state on its way to showing the new loading state.
  activeCheck = { id: me, cancel: teardown };
  chrome.storage.onChanged.addListener(onChange);

  const startNetworkCheck = ({ preserveCurrent = false } = {}) => {
    if (resolved) return;
    if (!preserveCurrent) {
      loadingMessage.textContent = DEFAULT_LOADING_MESSAGE;
      showState(stateLoading);
    }
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
    const stored = data[key];
    if (stored?.checking && urlsMatch(stored.pageUrl, tab.url)) {
      renderResult(stored);
      startNetworkCheck({ preserveCurrent: true });
      return;
    }
    if (storedResultApplies(stored)) finalize(stored);
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
  if (result.archived) {
    renderArchivedResult(result);
    return;
  }
  if (result.error) {
    showState(stateError);
    return;
  }
  if (result.checking) {
    renderLoadingResult(result);
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

  renderArchivedResult(result);
}

function renderLoadingResult(result) {
  const statuses = getServiceStatuses(result);
  const pending = Object.keys(statuses).filter(
    (service) => statuses[service] === "checking"
  );
  const finished = Object.keys(statuses).filter(
    (service) => statuses[service] !== "checking"
  );

  if (finished.length && pending.length) {
    loadingMessage.textContent = `${finished
      .map((service) => statusSummary(service, statuses[service]))
      .join(". ")}. Checking ${formatServiceList(pending)}...`;
  } else {
    loadingMessage.textContent = DEFAULT_LOADING_MESSAGE;
  }

  showState(stateLoading);
}

function renderArchivedResult(result) {
  resultsList.innerHTML = "";
  const statuses = getServiceStatuses(result);
  const pending = Object.keys(statuses).filter(
    (service) => statuses[service] === "checking"
  );
  archivedSubtitle.textContent = pending.length
    ? `Snapshot found; still checking ${formatServiceList(pending)}.`
    : DEFAULT_ARCHIVED_SUBTITLE;

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

  pending.forEach((service) => {
    resultsList.appendChild(createStatusRow(serviceName(service), "Still checking..."));
  });

  showState(stateArchived);
}

init();
