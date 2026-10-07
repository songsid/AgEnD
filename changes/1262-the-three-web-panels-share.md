---
section: Security
---
- **The three web panels share one navigation and one session menu, and `/` opens the dashboard.** `/ui`, `/view`
  and `/settings` carry the same *Dashboard · View · Settings* links and a Session button: which browser you are
  signed in as, when the session ends, every other signed-in device (with a Sign-out for each) and Sign out
  everywhere. It is one small script and stylesheet (`/assets/shell.js`, `/assets/shell.css`), not a rewrite of
  the panels.
