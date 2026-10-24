---
section: Fixed
---
- **DM notice preferences remain compatible with stable and Mac restore versions (#2580).** Settings now stores DM routing in `web.notice_delivery`, keeping `web.notify_login` and `defaults.tips` boolean. Older releases post to the original topics and retain the preference for a later upgrade. New fleets still choose DM sign-in notices; the short-lived string form is converted with a backup. Downgrade CI now checks the generated YAML against the published old validator and its config rewrite.
