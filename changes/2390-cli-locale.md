---
section: Changed
---
- **The CLI now chooses its language the way the fleet does.** It uses an explicit `defaults.locale` first, then the host's timezone (UTC+8 → zh-TW), then English. A UTC+8 host with no `defaults.locale` used to get English CLI lines next to zh-TW chat. It now gets zh-TW from `agend settings`, restart / start / stop, bug-report and the other localized lines. To keep English, set `defaults.locale: en`. Lines that other programs read (the updater, the Windows installer and shortcuts) stay English, and a test pins them (#2390).
