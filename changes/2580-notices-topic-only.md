---
section: Changed
---
- **Sign-in notices and daily tips post in the topic again, never by DM (#2580).** The DM choice in the 2.3.2 betas is withdrawn: a Telegram bot cannot DM someone who has not started it. `web.notify_login` and `defaults.tips` are Topic or Off in Settings, and new fleets no longer opt sign-in notices into DM. An existing `"dm"` value or `web.notice_delivery` route still loads, reads as on, and is rewritten as a boolean on startup with a `.bak`. Sign-in codes, guest codes and public-link delivery stay private.
