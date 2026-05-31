export const ARCHIVE_TODAY_HOSTS = new Set([
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.md",
]);

export const ARCHIVE_SERVICE_HOSTS = new Set([
  ...ARCHIVE_TODAY_HOSTS,
  "web.archive.org",
]);

// Exact-host exclusions: only the listed hostname is skipped. Use this tier
// when a domain also hosts archivable content, so siblings stay checkable
// (e.g. www.google.com is skipped but docs.cloud.google.com is not).
export const EXCLUDED_HOSTS = new Set([
  "www.capitaliq.spglobal.com",
  "google.com",
  "www.google.com",
  "youtube.com",
  "www.youtube.com",
]);

// Suffix exclusions: the listed host AND any of its subdomains are skipped.
// Use this tier either to blanket a whole domain whose every subdomain is a
// login/app/feed page, or to target a specific dead subdomain of an otherwise
// archivable domain (the Google pattern: drive.google.com is skipped, but
// google.com siblings like docs.cloud.google.com remain checkable).
export const EXCLUDED_HOST_SUFFIXES = [
  // Google services (specific subdomains; the rest of google.com is checkable)
  "mail.google.com",
  "calendar.google.com",
  "contacts.google.com",
  "maps.google.com",
  "drive.google.com",
  "docs.google.com",
  "gemini.google.com",
  // Social feeds (whole domain — login/personalised/ephemeral)
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "pinterest.com",
  "snapchat.com",
  "threads.net",
  // Messaging (whole domain)
  "discord.com",
  "messenger.com",
  "web.whatsapp.com",
  "web.telegram.org",
  // Email / personal (whole domain), plus specific webmail subdomains
  "outlook.com",
  "live.com",
  "icloud.com",
  "proton.me",
  "mail.yahoo.com",
  // Search engines (ephemeral query pages)
  "bing.com",
  "duckduckgo.com",
  "yandex.com",
  "baidu.com",
  // Streaming / DRM media (login, dynamic)
  "netflix.com",
  "twitch.tv",
  "spotify.com",
  "disneyplus.com",
  "hulu.com",
  "primevideo.com",
  // Cloud storage / productivity (private docs / app surfaces)
  "dropbox.com",
  "app.slack.com",
  "atlassian.net",
  // AI chat (private sessions); openai.com itself stays checkable
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
];

export function isPrivateHost(hostname) {
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

export function isArchiveServiceHost(hostname) {
  return ARCHIVE_SERVICE_HOSTS.has(hostname.toLowerCase());
}

export function isExcludedHost(hostname) {
  const h = hostname.toLowerCase();
  if (EXCLUDED_HOSTS.has(h)) return true;
  return EXCLUDED_HOST_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith("." + suffix)
  );
}

export function isCheckableUrl(url) {
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

// Multi-label public suffixes where the registrable domain is the last THREE
// labels (e.g. bbc.co.uk, not co.uk). Not the full Public Suffix List — just
// the common cases — which is enough to suggest a sensible "whole domain" to
// ignore. Worst case the suggestion is slightly too broad/narrow; the user
// still sees the exact string before confirming.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "co.jp",
  "co.kr",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.cn",
  "com.mx",
  "co.in",
  "co.nz",
  "co.za",
]);

// Suggest the registrable ("whole") domain for a hostname, used to offer an
// "ignore the entire domain" action. www. is stripped first.
export function baseDomain(hostname) {
  if (!hostname) return hostname;
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

// Test a hostname against a user-maintained ignore ruleset of the shape
// { hosts: string[], domains: string[] }. `hosts` are exact-hostname matches;
// `domains` match the host itself and any subdomain of it.
export function matchesIgnoreRules(hostname, rules) {
  if (!hostname || !rules) return false;
  const h = hostname.toLowerCase();
  const hosts = rules.hosts || [];
  const domains = rules.domains || [];
  if (hosts.includes(h)) return true;
  return domains.some((d) => h === d || h.endsWith("." + d));
}
