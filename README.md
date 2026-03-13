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
| Wayback Machine | `https://web.archive.org/cdx/search/cdx?url=<url>&sort=oldest` | CDX API |

Both APIs return structured data with no anti-bot restrictions. If either returns a snapshot, the badge checkmark is shown.

### Badge

The badge uses Chrome's `chrome.action.setBadgeText` API:

| State | Badge |
|---|---|
| Checking | Grey `…` |
| Archived (either source) | Dusk Blue `✓` |
| Not archived | _(no badge)_ |

### Caching

Results are cached in memory (per service worker lifetime) to avoid redundant network requests when switching between already-visited tabs. Session storage (`chrome.storage.session`) is used to pass results to the popup.

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
| `tabs` | Read the URL of the active tab |
| `activeTab` | Access the current tab when the popup is opened |
| `storage` | Cache results in session storage for the popup |
| `host_permissions` for `archive.ph`, `web.archive.org`, etc. | Make cross-origin requests to archive APIs from the service worker |

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
