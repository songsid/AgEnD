---
section: Added
---
- Web chat, HTML previews: **Settings → Web dashboard → HTML previews may load libraries from cdnjs / jsDelivr** (`web.preview_cdn`, off by default). When it is on, a preview's scripts, styles and fonts may come from `cdnjs.cloudflare.com/ajax/libs/` and `cdn.jsdelivr.net/npm/`, and nowhere else. **Those requests leave this machine:** the CDN sees them, and a page could use them to send data out. A preview still cannot fetch or post anything, and still cannot use your sign-in. When it is off, a page whose library was blocked says so in the panel. The public link follows the same setting.
