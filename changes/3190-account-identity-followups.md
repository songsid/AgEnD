---
section: Changed
---
- **The Runtime page's account list (credential profiles and which account each sign-in is) is styled by the lazy Runtime page itself**, not by the shared stylesheet, so a tab that was opened before an upgrade no longer shows it unstyled until it is reloaded. The docs now say that the masked e-mail and plan are visible only to a fleet admin on the dashboard reached directly (not over the public link or a fixed address), and a test reads the key names of a real `claude auth status` against what AgEnD reads from it.
