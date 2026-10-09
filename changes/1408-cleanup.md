---
section: Changed
---
- **The web app's last rough edges (#1408 step 5).**
  - Every "are you sure?" is the app's own dialog, with a button that says what it does: leaving Settings with changes not applied, an access change, Restart AgEnD, deleting an agent, a schedule or a team, removing a connection, rebinding it, and allowing HTML previews. A sign-out the server could not save is said on the sign-in page instead of in a browser alert.
  - The sign-in page has the app's look, in light and dark.
  - A connection in Settings fits on one line on a desktop; on a phone its details go under it.
  - Developer → Apply & save writes only the parts of `fleet.yaml` you changed.
  - On a phone, the tour points at ☰ for the instance list.
  - The old shared page script and stylesheet (`/assets/shell.js`, `/assets/shell.css`) are gone: every page is the app or the sign-in page.
