---
section: Upgrade Notes
---
- **[Behaviour change] The web panels sign in with a one-time code, and a
  dashboard link no longer carries a credential.** `/dashboard` used to paste the
  fleet-wide `web.token` into `/view?token=`, `/settings?token=` and `/ui?token=`
  — into chat history, browser history and screenshots, where it stayed valid
  until `agend web-token rotate`. It now gives the sign-in page and an 8-character
  code that works once and expires in 5 minutes; typing it there starts a
  **server-side session** (an opaque random id the server can expire, list and
  revoke — not the old cookie that was `sha256(web.token)`, identical on every
  device and valid until rotation). **Everyone signs in once after upgrading:**
  the old cookie is no longer accepted. Sessions end 12 hours after sign-in or
  after 2 hours idle, survive a fleet restart, and every write from a page now
  also needs a per-session `X-Agend-CSRF` header and a matching `Origin`.
  `/dashboard revoke` (on Discord: `/dashboard` with `action: revoke`) signs every browser out; `agend web --code` prints a code on
  the host; `agend web-token rotate` still kills every session at once. The
  header token (`X-Agend-Token`) is unchanged for the CLI and scripts. **A
  `?token=` in a URL is no longer a credential anywhere on `/ui` and `/settings`:**
  an old `?token=` link or bookmark opens the sign-in page — sign in there once
  with a one-time code from `agend web` or `/dashboard`. `agend web` now prints a
  code and opens `/signin` instead of a token link. New sign-ins are announced in the General topic
  (`web.notify_login: false` to silence).
