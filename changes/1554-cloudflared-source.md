---
section: Changed
---
- **The cloudflared download for the public link works on slow connections (#1554).**
  - It no longer fails after a fixed 5 minutes. It fails only when no data has arrived for 60 seconds, with a 30-minute overall limit, so a slow download that keeps moving finishes.
  - **On Linux it now comes from Cloudflare's own package repository first** (pkg.cloudflare.com), and from the GitHub release if the package is missing, stalls, is too slow or does not match. The package is also half the size.
  - Both sources are checked against the same pinned SHA256. The package's binary is unpacked by AgEnD itself, with nothing else installed.
  - macOS still downloads from GitHub, since Cloudflare publishes no macOS package.
  - On `/dashboard`, step ② says when it switched to GitHub and why.
