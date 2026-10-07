---
section: Upgrade Notes
---
- **[Behaviour change] `/view` no longer takes the web token in its URL or a text box.**
  Saving a profile or avatar (and the sidebar order) used to work with the
  fleet-wide `web.token` sent as `?token=` — which `/dashboard`'s "View (edit)" link
  put in the address bar, and which `view.html` then appended to *every* API
  request and kept in `localStorage`. Writes now need a signed-in session (with
  the same CSRF checks as the other panels) or `X-Agend-Token` from a script; a
  `?token=` is refused as a write credential, the token box is gone, and Edit sends
  a signed-out visitor to the sign-in page and back. **Reading `/view` stays open by
  default** (the live terminal capture included); the new `web.view_access: session`
  requires a sign-in for reads too. The unused `view.token` file (a read-only
  credential nothing ever accepted) is no longer written, and an old one is
  deleted at startup.
