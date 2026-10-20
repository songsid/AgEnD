---
section: Changed
---
- **A usage row whose read fails keeps its last known numbers (#2236).** An expired token ("Access token expired — …"), a rate limit, a network blip or any other error used to replace the whole row with the error. Now the row keeps the numbers from the last good read, up to a week old.
  - **Marked:** the numbers are greyed, and a line says why and when: **expired · cached at 14:05**, **not updated** or **couldn't read**. For an expiry or another error, what to do (for example "run `agy` once") is on a second line.
  - **Past resets:** a window that has reset since shows **reset since …**, never its old percentage.
  - **Where:** the usage panel, rail and dialog, the Telegram and Discord `/usage` text, and `get_usage` (rows carry `stale`, `cachedAt` and `staleCause`; a reset metric carries `resetPassed`).
  - **Never made up:** a provider never read successfully still shows its error, and a good read clears the mark.
  - **After a restart:** the numbers come from `usage-last-good.json` in AGEND_HOME.
