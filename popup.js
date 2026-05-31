import { isCheckableUrl, baseDomain, matchesIgnoreRules } from "./url-policy.js";

const ARCHIVE_TODAY = "https://archive.ph";
const WAYBACK_SAVE = "https://web.archive.org/save/";
const IGNORE_STORAGE_KEY = "ignoredSites";

const stateLoading = document.getElementById("state-loading");
const stateArchived = document.getElementById("state-archived");
const stateNotArchived = document.getElementById("state-not-archived");
const stateNa = document.getElementById("state-na");
const stateError = document.getElementById("state-error");
const stateIgnored = document.getElementById("state-ignored");
const resultsList = document.getElementById("results-list");
const linkSaveArchive = document.getElementById("link-save-archive");
const linkSaveWayback = document.getElementById("link-save-wayback");
const ignoredMessage = document.getElementById("ignored-message");
const linkReenable = document.getElementById("link-reenable");
const loadingMessage = stateLoading.querySelector(".message");
const archivedSubtitle = stateArchived.querySelector(".subtitle");
const DEFAULT_LOADING_MESSAGE = "Checking archives...";
const DEFAULT_ARCHIVED_SUBTITLE = "Oldest snapshots found";
const SERVICE_NAMES = {
  archiveToday: "archive.today",
  wayback: "Wayback Machine",
};

function showState(el) {
  [
    stateLoading,
    stateArchived,
    stateNotArchived,
    stateNa,
    stateError,
    stateIgnored,
  ].forEach((s) => s.classList.add("hidden"));
  el.classList.remove("hidden");
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

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function getIgnoreRules() {
  const data = await chrome.storage.local.get(IGNORE_STORAGE_KEY);
  const raw = data[IGNORE_STORAGE_KEY];
  return {
    hosts: Array.isArray(raw?.hosts) ? raw.hosts : [],
    domains: Array.isArray(raw?.domains) ? raw.domains : [],
  };
}

function setIgnoreRules(rules) {
  return chrome.storage.local.set({ [IGNORE_STORAGE_KEY]: rules });
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

function showIgnoredState(tab, rules) {
  const host = hostnameOf(tab.url);
  const matchedDomain = (rules.domains || []).find(
    (d) => host === d || host.endsWith("." + d)
  );
  if (matchedDomain) {
    ignoredMessage.textContent = `Archive checks are turned off for ${matchedDomain} and its subdomains.`;
  } else {
    ignoredMessage.textContent = `Archive checks are turned off for ${host}.`;
  }
  showState(stateIgnored);
}

function wireIgnoreControls(tab) {
  const host = hostnameOf(tab.url);
  if (!host) return;
  const domain = baseDomain(host);

  document.querySelectorAll(".btn-ignore-host").forEach((btn) => {
    btn.textContent = `Ignore ${host}`;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const rules = await getIgnoreRules();
      if (!rules.hosts.includes(host)) rules.hosts.push(host);
      await setIgnoreRules(rules);
      showIgnoredState(tab, rules);
    });
  });

  document.querySelectorAll(".btn-ignore-domain").forEach((btn) => {
    btn.textContent = `Ignore ${domain}`;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const rules = await getIgnoreRules();
      if (!rules.domains.includes(domain)) rules.domains.push(domain);
      await setIgnoreRules(rules);
      showIgnoredState(tab, rules);
    });
  });
}

function wireReenable(tab) {
  const host = hostnameOf(tab.url);
  linkReenable.addEventListener("click", async (e) => {
    e.preventDefault();
    const rules = await getIgnoreRules();
    rules.hosts = rules.hosts.filter((h) => h !== host);
    rules.domains = rules.domains.filter(
      (d) => !(host === d || host.endsWith("." + d))
    );
    await setIgnoreRules(rules);
    performCheck(tab, { force: true });
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
  wireIgnoreControls(tab);
  wireReenable(tab);

  const host = hostnameOf(tab.url);
  const rules = await getIgnoreRules();
  if (host && matchesIgnoreRules(host, rules)) {
    showIgnoredState(tab, rules);
    return;
  }

  performCheck(tab, { force: false });
}

function renderResult(result) {
  if (result.ignored) {
    showState(stateIgnored);
    return;
  }
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

function renderFooterVersion() {
  const version = chrome.runtime.getManifest().version;
  const el = document.getElementById("footer-version");
  if (el) el.textContent = `v${version}`;
}

renderFooterVersion();
init();
