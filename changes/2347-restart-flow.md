---
section: Changed
---
- **Web: saved changes that need AgEnD restarted say so on every page (#2347).** Until AgEnD restarts, a line at the top reads **N saved change(s) take effect after AgEnD restarts**, names the settings, and offers **Restart now** (asks first; one restart for all of them) and **Later**. It survives a reload and shows in other tabs. AgEnD never restarts on its own. Over a temporary public link it offers no restart, and for a hand edit of `fleet.yaml` it says to run `agend restart` on the host. New read: `GET /api/settings/restart-pending`.
