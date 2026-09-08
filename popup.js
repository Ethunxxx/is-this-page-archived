import {
  isCheckableUrl,
  baseDomain,
  isExcludedHost,
  matchesIgnoreRules,
} from "./url-policy.js";

const ARCHIVE_TODAY = "https://archive.ph";
const WAYBACK_SAVE = "https://web.archive.org/save/";
const IGNORE_STORAGE_KEY = "ignoredSites";

const stateResults = document.getElementById("state-results");
const stateNa = document.getElementById("state-na");
const stateIgnored = document.getElementById("state-ignored");
const resultsIcon = document.getElementById("results-icon");
const resultsTitle = document.getElementById("results-title");
const resultsSubtitle = document.getElementById("results-subtitle");
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
const DEFAULT_ARCHIVED_SUBTITLE = "Oldest snapshots found";
const POPUP_CHECK_TIMEOUT_MS = 18000;
const SERVICE_NAMES = {
  archiveToday: "archive.today",
  wayback: "Wayback Machine",
};
const SERVICE_ORDER = ["archiveToday", "wayback"];

function showState(el) {
  [stateResults, stateNa, stateIgnored].forEach((s) =>
    s.classList.add("hidden")
  );
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

const ROW_ICON_PATHS = {
  // circle with a dash: no snapshot
  not_found: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12h8"],
  // clock: busy / rate-limited
  rate_limited: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  // shield with a check: human verification (CAPTCHA) needed
  captcha: ["M12 3l8 3v6c0 4.6-3.4 8.4-8 9-4.6-.6-8-4.4-8-9V6l8-3z", "M9 12l2 2 4-4"],
  // alert triangle: unreachable
  error: [
    "M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
    "M12 9v4",
    "M12 17h.01",
  ],
};

const ROW_STATUS_MESSAGES = {
  checking: "Checking...",
  not_found: "No snapshot found",
  rate_limited: "Busy, try again later",
  captcha: "CAPTCHA required",
  error: "Could not be reached",
  skipped: "Not checked",
};

function createRowStatusIcon(status) {
  const paths = ROW_ICON_PATHS[status] || ROW_ICON_PATHS.not_found;
  const wrap = document.createElement("span");
  wrap.className = "row-status-icon";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  paths.forEach((d) => {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  });
  wrap.appendChild(svg);
  return wrap;
}

function createServiceRow(service, status, memento) {
  const row = document.createElement("div");
  row.className = "result-row";

  const info = document.createElement("div");
  info.className = "result-info";

  const name = document.createElement("div");
  name.className = "result-service";
  name.textContent = serviceName(service);
  info.appendChild(name);

  const detail = document.createElement("div");
  detail.className = "result-date";

  if (status === "found" && memento) {
    detail.textContent = formatDatetime(memento.datetime);
    info.appendChild(detail);

    const btn = document.createElement("button");
    btn.className = "btn-open";
    btn.textContent = "Open";
    btn.addEventListener("click", () => openUrl(memento.url));

    row.appendChild(info);
    row.appendChild(btn);
    return row;
  }

  detail.textContent = ROW_STATUS_MESSAGES[status] || ROW_STATUS_MESSAGES.not_found;
  info.appendChild(detail);
  row.appendChild(info);

  if (status === "captcha") {
    const btn = document.createElement("button");
    btn.className = "btn-open";
    btn.textContent = "Solve";
    btn.title = "Open archive.today's CAPTCHA in a small window";
    btn.addEventListener("click", () => openCaptchaWindow(btn));
    row.appendChild(btn);
    return row;
  }

  if (status === "checking") {
    const spinner = document.createElement("span");
    spinner.className = "row-spinner";
    row.appendChild(spinner);
  } else {
    row.appendChild(createRowStatusIcon(status));
  }

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

// Render the unified card with both rows forced into one status. Used when
// there is no per-service result to show: the initial loading state
// ("checking"), a timed-out check ("rate_limited"), or a missing tab /
// non-checkable URL ("error").
function renderUniformStatus(status) {
  renderUnifiedResult({ services: { archiveToday: status, wayback: status } });
}

let activeCheck = null;
let variantSearchActive = false;
let currentTab = null;

// archive.today is showing its reCAPTCHA wall. The service worker opens it in
// a small popup window, watches for the solve, re-checks the page and closes
// the window. This popup loses focus (and closes) when that window opens;
// reopening it afterwards shows the fresh result.
function openCaptchaWindow(btn) {
  if (!currentTab) return;
  btn.disabled = true;
  btn.textContent = "Opening\u2026";
  chrome.runtime
    .sendMessage({ type: "solveArchiveTodayCaptcha", tabId: currentTab.id, url: currentTab.url })
    .catch(() => {})
    .finally(() => {
      btn.disabled = false;
      btn.textContent = "Solve";
    });
}

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
  const finalize = (result, { timedOut = false } = {}) => {
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
    } else if (timedOut) {
      // Nothing landed in time — almost always the services being slow, not a
      // broken extension. Show the recoverable "busy" state, not a hard error.
      renderUniformStatus("rate_limited");
    } else {
      renderUniformStatus("error");
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
      renderUniformStatus("checking");
    }
    // Tell the service worker to run the check. Without this, a cold-
    // respawned SW with no pending tab event would never check this tab
    // and the popup would just sit on the loading state until its timeout.
    // The force flag is only set by the Recheck button.
    chrome.runtime
      .sendMessage({ type: "check", tabId: tab.id, url: tab.url, force: !!force })
      .catch(() => {});
    timeoutId = setTimeout(() => finalize(null, { timedOut: true }), POPUP_CHECK_TIMEOUT_MS);
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
  if (variantSearchActive) return;
  const statuses = getServiceStatuses(result);
  // Only worth searching when archive.today itself was reachable but had no exact
  // match — that's when a param-variant snapshot might still exist. Skip when it
  // errored or was rate-limited (the heavier wildcard search would just fail too).
  // The other service's state is irrelevant to this archive.today-only search.
  if (statuses.archiveToday !== "not_found") return;
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return;
  }
  // Nothing to find for a bare origin; don't spend a search on it.
  if (parsed.pathname.length <= 1) return;

  variantSearchActive = true;
  // The archive.today row is always visible now, so show its spinner while
  // the slower wildcard search runs, whatever the other service reported.
  renderResult(withArchiveTodayChecking(result));

  const revert = () => renderResult(result);
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
    renderUniformStatus("error");
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

  currentTab = tab;
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
  renderUnifiedResult(result);
}

function setResultsHeader(icon, title, subtitle) {
  resultsIcon.innerHTML = icon;
  resultsTitle.textContent = title;
  resultsSubtitle.textContent = subtitle;
}

function renderUnifiedResult(result) {
  const statuses = getServiceStatuses(result);
  const pending = SERVICE_ORDER.filter(
    (service) => statuses[service] === "checking"
  );
  const anyFound = SERVICE_ORDER.some(
    (service) => statuses[service] === "found" || result[service]
  );

  if (anyFound) {
    setResultsHeader(
      "&#10003;",
      "Archived",
      pending.length
        ? `Snapshot found; still checking ${formatServiceList(pending)}.`
        : DEFAULT_ARCHIVED_SUBTITLE
    );
  } else if (pending.length) {
    setResultsHeader("&#8987;", "Checking", "Checking archives...");
  } else if (statuses.archiveToday === "captcha") {
    setResultsHeader(
      "&#128274;",
      "Human Check Needed",
      "archive.today is asking for a one-time CAPTCHA. Solve it to finish the check."
    );
  } else if (SERVICE_ORDER.some((s) => statuses[s] === "rate_limited")) {
    setResultsHeader(
      "&#8987;",
      "Services Busy",
      "Rate-limited or responding slowly. Try again in a moment."
    );
  } else if (SERVICE_ORDER.some((s) => statuses[s] === "error")) {
    setResultsHeader("!", "Check Failed", "Could not reach the archive services.");
  } else {
    setResultsHeader("&mdash;", "Not Archived", "No archive found for this page.");
  }

  resultsList.innerHTML = "";
  SERVICE_ORDER.forEach((service) => {
    const memento = result[service];
    const status = memento ? "found" : statuses[service] || "not_found";
    resultsList.appendChild(createServiceRow(service, status, memento));
  });

  showState(stateResults);
}

function renderFooterVersion() {
  const version = chrome.runtime.getManifest().version;
  const el = document.getElementById("footer-version");
  if (el) el.textContent = `v${version}`;
}

renderFooterVersion();
init();
