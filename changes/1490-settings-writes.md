---
section: Security
---
- **Settings confirmations can no longer be bypassed under an "applies now" setting (#1490).**
  - A sensitive field placed inside an immediate setting's object (for example `persona: { bot_token: … }` or `persona: { allowed_users: … }`) skipped the admin confirmation.
  - Such a field is now confirmed like any other secret or access change. An unknown field there is refused.
  - Only the known parts of `status_emojis` and `hang_detector` still apply without confirmation.
- **Saving connections in Settings writes only connection fields (#1490).**
  - `PUT /api/settings/fleet/channels` refuses any field Settings does not own, such as an inline `bot_token`, an unknown option or an unknown access field.
  - A field added by hand to fleet.yaml still passes through unchanged.
