---
section: Security
---
- **…and no inline style applies unless it is the page's own (#1300).** `style-src` no longer allows
  `'unsafe-inline'` either: each panel's `<style>` block carries the same per-response nonce, and no panel has a
  `style="…"` attribute any more (the dashboard's went in #1307; /view's and /settings' now — the live terminal's
  colours and the usage meters are set through the style object). Injected markup cannot add inline styles of its own
  (it can still use the page's existing class names). The web terminal keeps its own policy.
