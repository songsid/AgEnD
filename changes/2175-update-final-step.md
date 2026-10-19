---
section: Fixed
---
- **The update message on Telegram reaches its last step (#2175).** After `agend update` or `/update`, Telegram often kept "Starting... 13/14 instances" and never showed "✅ AgEnD updated to vX", although the update had succeeded. The message was being edited every second, and Telegram (about 20 messages a minute per group) answered with a rate-limit wait longer than the final step allowed. Now:
  - progress edits to Telegram are at most one every 6 s, and a rate-limit wait is never ignored;
  - a final step that can't land during startup is retried for up to 10 minutes — edited in place, or posted as a new message — instead of being dropped.
