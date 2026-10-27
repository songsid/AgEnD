---
section: Changed
---
- **No more daily tips or "2.2 adds web chat" message in General (#2783).** The tip AgEnD posted in General once a day is gone, along with **Daily tips** in Settings → Agent defaults and `/tips on` / `/tips off`. `/tips` still draws a tip on demand, and `/tips advanced on` stays. A `defaults.tips` already in `fleet.yaml` still loads, with no warning, and is left in the file, so a downgrade keeps your choice. The one-time web chat announcement that new installs also received is gone too.
