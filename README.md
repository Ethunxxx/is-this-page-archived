# Is This Page Archived?

A minimalist Chrome extension that checks whether the current page has been archived, and lets you jump straight to the oldest available snapshot.

> **Hobby project** — created for fun and built for my own personal use. Feel free to use, fork, or adapt it however you like.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-274C77)
![License](https://img.shields.io/badge/License-Unlicense-6096BA)

---

## What it does

- Checks **archive.today** and the **Wayback Machine** in parallel every time you navigate to a page
- Displays a **checkmark badge** on the extension icon if either service has an archived copy
- Click the icon to open the popup, which shows:
  - The oldest archived snapshot from **archive.today** (listed first, when available)
  - The oldest archived snapshot from the **Wayback Machine** (listed second, when available)
  - A **Recheck** button to bypass the cache and run a fresh check
  - Links to submit the page to both services if no archive exists

## Installation

This extension is not yet on the Chrome Web Store. To install it manually:

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the project folder

The extension will appear in your toolbar immediately.

---

## How it works

### Archive checking

On every completed page navigation the service worker fires two requests in parallel:

| Service | Endpoint | Method |
|---|---|---|
| archive.today | `https://archive.ph/timemap/<url>` | Memento TimeMap (RFC 7089) |
| Wayback Machine | `https://web.archive.org/cdx/search/cdx?url=<url>&output=json&limit=1&fl=timestamp,original&sort=oldest` | CDX API |

Both APIs return structured data with no anti-bot restrictions.

### Response validation

Both services occasionally return a snapshot for a *different* URL than the one requested (typically the host root) when no exact match exists. The extension rejects these:

- **archive.today**: the TimeMap's `rel="original"` URL must match the requested URL, the memento URL must live on a known archive.today host (`archive.ph`, `archive.today`, `archive.is`, `archive.md`), and the original URL embedded in the memento path must match.
- **Wayback**: the `original` column returned by CDX must match the requested URL.

URL matching is done after normalization (see below) so trivial differences like a trailing slash don't cause false rejects.

### Badge

The badge is set per-tab via `chrome.action.setBadgeText`:

| State | Badge |
|---|---|
| Checking | Grey `…` |
| Archived (either source) | Dusk Blue `✓` |
| Not archived / error / non-checkable URL | _(no badge)_ |

### Popup states

| State | Shown when |
|---|---|
| Checking | Fetches are in flight |
| Archived | At least one service returned a valid snapshot |
| Not Archived | Both services succeeded and neither had a snapshot — also shows "Save to…" links |
| Check Failed | Both upstream calls errored, or the popup timed out after 12s |
| No Page to Check | The active tab isn't an HTTP(S) URL, or is on a private/local host |

### Caching

Results are kept in an in-memory `Map` in the service worker with:

- **1-hour TTL** per entry
- **LRU eviction** capped at 500 entries (pruned to 250)
- **In-flight deduplication** so two tabs on the same URL share a single fetch
- **Failure isolation** — if either upstream call rejects, the result is *not* cached, so a transient outage doesn't poison results for the rest of the service-worker lifetime

The cache is keyed by a normalized form of the URL: `www.` stripped, host lowercased, trailing slashes removed, fragment dropped. So `https://Example.com/foo/` and `https://www.example.com/foo` share an entry.

Clicking a "Save to…" link in the popup invalidates that URL's cache entry so the next visit re-checks instead of returning the stale "not archived" result. The **Recheck** button does the same, then forces an immediate fresh check.

`chrome.storage.session` is used to hand results from the service worker to the popup, keyed by tab ID.

### Robustness

- **Fetch timeout**: each upstream call is aborted after 10s; the popup gives up after 12s and shows the error state.
- **Debouncing**: tab updates are debounced 300ms so a redirect chain only triggers one check.
- **Tab-navigation race protection**: if the tab navigates away while a fetch is in flight, the result is dropped instead of painted onto the new page.
- **Tab activation**: switching to a tab triggers a check (served from cache if fresh).
- **Tab cleanup**: closing a tab clears its session-storage entry and any pending debounce timer.

---

## Privacy

URLs on private or local hosts are **never sent to either archive service**. The following are filtered out before any network call:

- `localhost` and any `*.localhost`
- TLDs: `.local`, `.internal`, `.intranet`, `.lan`, `.test`, `.example`, `.invalid`
- RFC 1918 IPv4 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Loopback (`127.0.0.0/8`, `::1`) and the `0.0.0.0/8` range
- Link-local: `169.254.0.0/16` and IPv6 `fe80::/10`
- IPv6 unique-local (`fc00::/7` — `fc*`/`fd*`)

Non-HTTP(S) URLs (`chrome://`, `file://`, etc.) are also skipped.

---

## File structure

```
is-this-page-archived/
├── manifest.json       # Manifest V3 config
├── background.js       # Service worker: archive checks, badge, caching
├── popup.html          # Popup UI (Serene Blue design)
├── popup.js            # Popup logic
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

---

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Read the URL of the active tab and react to navigation events |
| `activeTab` | Access the current tab when the popup is opened |
| `storage` | Hand results from the service worker to the popup via session storage |
| host: `https://archive.ph/*` | TimeMap requests to archive.today |
| host: `https://archive.today/*` | Allow memento URLs served from the `archive.today` host |
| host: `https://web.archive.org/*` | CDX API requests and Save Page Now links |

---

## Design

The popup uses the **Serene Blue** palette:

| Colour | Hex | Use |
|---|---|---|
| Platinum | `#E7ECEF` | Background |
| Dusk Blue | `#274C77` | Headings, badge |
| Steel Blue | `#6096BA` | Buttons |
| Icy Blue | `#A3CEF1` | Hover states |
| Grey Olive | `#8B8C89` | Secondary text, dates |

---


## License

[The Unlicense](LICENSE) — this software is released into the public domain. No restrictions, no attribution required, do whatever you want with it.
