---
section: Security
---
- **No inline script runs on the web panels unless it is the page's own (#1268).** `script-src` no longer allows
  `'unsafe-inline'`: each panel's own script is served with a fresh per-response nonce, and the dashboard's buttons
  no longer carry `onclick=` attributes (one listener runs a fixed list of actions named in `data-act`). Markup
  injected into a page — an `onerror=` handler, a `<script>` — no longer runs.
