---
section: Fixed
---
- **A DM notice setting saved by a 2.3.2 beta still loads (#2580).** A `"dm"` value for `web.notify_login` or `defaults.tips`, or any `web.notice_delivery` key, is accepted with a warning and read as on, posted in the topic. Startup, reload and Settings saves rewrite it as a plain boolean and keep a `.bak`, so every older release reads the file.
