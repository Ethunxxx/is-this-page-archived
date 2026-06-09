import {
  isCheckableUrl,
  baseDomain,
  isExcludedHost,
  matchesIgnoreRules,
} from "./url-policy.js";

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
const ignoredMessage = document.getElementById("ignored-message");
const linkReenable = document.getElementById("link-reenable");
const reenableLinks = linkReenable.parentElement;
const controlCard = document.getElementById("control-card");
const controlActions = document.getElementById("control-actions");
const excludePanel = document.getElementById("exclude-panel");
const btnArchive = document.getElementById("btn-archive");
const btnExclude = document.getElementById("btn-exclude");
const btnExcludeLabel = btnExclude.querySelector(".control-label");
const btnExcludeHost = document.getElementById("btn-exclude-host");
const btnExcludeDomain = document.getElementById("btn-exclude-domain");
const btnExcludeCancel = document.getElementById("btn-exclude-cancel");
const loadingMessage = stateLoading.querySelector(".message");
const archivedSubtitle = stateArchived.querySelector(".subtitle");
const DEFAULT_LOADING_MESSAGE = "Checking archives...";
const DEFAULT_ARCHIVED_SUBTITLE = "Oldest snapshots found";
const POPUP_CHECK_TIMEOUT_MS = 15000;
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

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
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
let variantSearchActive = false;

function performCheck(tab, { force }) {
  // Tear down any previous check so a Recheck click can't double-listen.
  if (activeCheck) activeCheck.cancel();
  // A fresh check (including a Recheck) may warrant a new variant search.
  variantSearchActive = false;

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
    if (result) {
      renderResult(result);
      maybeSearchArchiveTodayVariants(tab, result);
    } else {
      showState(stateError);
    }
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
    // and the popup would just sit on the loading state until its timeout.
    // The force flag is only set by the Recheck button.
    chrome.runtime
      .sendMessage({ type: "check", tabId: tab.id, url: tab.url, force: !!force })
      .catch(() => {});
    timeoutId = setTimeout(() => finalize(null), POPUP_CHECK_TIMEOUT_MS);
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

// archive.today's exact lookup can't see a snapshot saved under a trailing-
// slash or junk-param variant of this URL. When it comes back empty, ask the
// service worker to run archive.today's (rate-limited) wildcard search. Done on
// popup open rather than the background sweep so normal browsing never triggers
// it. Fires at most once per check; a Recheck re-arms it.
function maybeSearchArchiveTodayVariants(tab, result) {
  if (variantSearchActive || result.error) return;
  const statuses = getServiceStatuses(result);
  if (statuses.archiveToday !== "not_found" && statuses.archiveToday !== "error") {
    return;
  }
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return;
  }
  // Nothing to find for a bare origin; don't spend a search on it.
  if (parsed.pathname.length <= 1) return;

  variantSearchActive = true;
  // If Wayback already gave us an archived view, show a gentle "checking" row
  // for archive.today while the slower search runs. If nothing was found at
  // all, search silently so we don't flash the full loading state.
  if (result.archived) renderResult(withArchiveTodayChecking(result));

  const revert = () => {
    if (result.archived) renderResult(result);
  };
  chrome.runtime
    .sendMessage({ type: "searchArchiveTodayVariants", tabId: tab.id, url: tab.url })
    .then((resp) => {
      if (resp && resp.archiveToday) {
        renderResult(mergeArchiveTodayIntoResult(result, resp.archiveToday));
      } else {
        revert();
      }
    })
    .catch(revert);
}

function withArchiveTodayChecking(result) {
  return {
    ...result,
    services: { ...getServiceStatuses(result), archiveToday: "checking" },
  };
}

function mergeArchiveTodayIntoResult(result, memento) {
  return {
    ...result,
    archived: true,
    archiveToday: memento,
    services: { ...getServiceStatuses(result), archiveToday: "found" },
  };
}

function wireRecheck(tab) {
  document.querySelectorAll(".btn-recheck").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      performCheck(tab, { force: true });
    });
  });
}

function showIgnoredState(tab, { source = "manual", rules = {} } = {}) {
  const host = hostnameOf(tab.url);

  if (source === "hardcoded") {
    ignoredMessage.textContent = `Archive checks are not run for ${host} because this site is excluded by default.`;
    reenableLinks.classList.add("hidden");
    showState(stateIgnored);
    return;
  }

  const matchedDomain = (rules.domains || []).find(
    (d) => host === d || host.endsWith("." + d)
  );
  ignoredMessage.textContent = matchedDomain
    ? `Archive checks are turned off for ${matchedDomain} and its subdomains.`
    : `Archive checks are turned off for ${host}.`;
  reenableLinks.classList.remove("hidden");
  showState(stateIgnored);
}

function showExcludePanel(show) {
  excludePanel.classList.toggle("hidden", !show);
  controlActions.classList.toggle("hidden", show);
}

function setControlExcluded(excluded) {
  showExcludePanel(false);
  btnArchive.disabled = excluded;
  btnExclude.disabled = false;
  if (excluded) {
    btnArchive.title = "Archiving is disabled because this site is excluded";
    btnExclude.title = "Re-enable archive checks for this site";
    btnExclude.dataset.action = "reenable";
    btnExcludeLabel.textContent = "Re-enable site";
  } else {
    btnArchive.title =
      "Save this page to archive.today and the Wayback Machine";
    btnExclude.title = "Stop checking archives for this site";
    btnExclude.dataset.action = "exclude";
    btnExcludeLabel.textContent = "Exclude site";
  }
}

async function reenableSite(tab) {
  const host = hostnameOf(tab.url);
  if (!host) return;

  const rules = await getIgnoreRules();
  rules.hosts = rules.hosts.filter((h) => h !== host);
  rules.domains = rules.domains.filter(
    (d) => !(host === d || host.endsWith("." + d))
  );
  await setIgnoreRules(rules);
  setControlExcluded(false);
  performCheck(tab, { force: true });
}

function wireControlBar(tab) {
  const host = hostnameOf(tab.url);
  if (!host) return;
  const domain = baseDomain(host);

  const pageUrl = tab.url;
  btnArchive.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "invalidate", url: pageUrl }).catch(() => {});
    openUrl(`${ARCHIVE_TODAY}/?url=${encodeURIComponent(pageUrl)}`);
    openUrl(WAYBACK_SAVE + encodeURIComponent(pageUrl));
  });

  btnExclude.addEventListener("click", () => {
    if (btnExclude.dataset.action === "reenable") {
      reenableSite(tab);
      return;
    }
    showExcludePanel(true);
  });
  btnExcludeCancel.addEventListener("click", () => showExcludePanel(false));

  btnExcludeHost.textContent = `Only ${host}`;
  btnExcludeHost.title = `Stop checking only ${host}`;
  btnExcludeHost.addEventListener("click", async () => {
    const rules = await getIgnoreRules();
    if (!rules.hosts.includes(host)) rules.hosts.push(host);
    await setIgnoreRules(rules);
    setControlExcluded(true);
    showIgnoredState(tab, { source: "manual", rules });
  });

  btnExcludeDomain.textContent = `${domain} and all subdomains`;
  btnExcludeDomain.title = `Stop checking ${domain} and every subdomain`;
  btnExcludeDomain.addEventListener("click", async () => {
    const rules = await getIgnoreRules();
    if (!rules.domains.includes(domain)) rules.domains.push(domain);
    await setIgnoreRules(rules);
    setControlExcluded(true);
    showIgnoredState(tab, { source: "manual", rules });
  });
}

function wireReenable(tab) {
  linkReenable.addEventListener("click", async (e) => {
    e.preventDefault();
    await reenableSite(tab);
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showState(stateError);
    return;
  }

  const host = hostnameOf(tab.url);
  if (!isWebUrl(tab.url) || !host) {
    showState(stateNa);
    return;
  }

  if (isExcludedHost(host)) {
    showIgnoredState(tab, { source: "hardcoded" });
    return;
  }

  if (!isCheckableUrl(tab.url)) {
    showState(stateNa);
    return;
  }

  wireRecheck(tab);
  wireControlBar(tab);
  wireReenable(tab);
  controlCard.classList.remove("hidden");

  const rules = await getIgnoreRules();
  if (host && matchesIgnoreRules(host, rules)) {
    setControlExcluded(true);
    showIgnoredState(tab, { source: "manual", rules });
    return;
  }

  performCheck(tab, { force: false });
}

function renderResult(result) {
  if (result.ignored) {
    getIgnoreRules()
      .then((rules) => {
        setControlExcluded(true);
        showIgnoredState({ url: result.pageUrl }, { source: "manual", rules });
      })
      .catch(() => showState(stateIgnored));
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
