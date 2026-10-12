---
section: Added
---
- **Web: preferences follow you across devices (#1665).** Theme, language, the sidebar's order, folded groups and filter, and the HTML-preview opt-in are now saved on the host, so a phone and a desktop stay the same. Each browser keeps a copy, and the page is served with the host's theme, so nothing flashes on load, even on a new device. On first load after the update, a device uploads what it had for anything the host doesn't have yet; after that the host's values win. Settings → **Preferences** shows what is synced and what stays on each device (the tour, text size, view fit, the sidebar shown or hidden, panel widths, desktop notifications). A public link can read these preferences but never change them, and it can never turn previews on.
