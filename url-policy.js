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

export const EXCLUDED_HOSTS = new Set([
  "www.capitaliq.spglobal.com",
  "www.google.com",
  "youtube.com",
  "www.youtube.com",
]);

export const EXCLUDED_HOST_SUFFIXES = [
  "mail.google.com",
  "calendar.google.com",
  "contacts.google.com",
  "maps.google.com",
  "drive.google.com",
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
