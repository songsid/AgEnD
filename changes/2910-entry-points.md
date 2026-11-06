---
section: Changed
---
- **A web-only fleet's entry points lead with the web (#2910).**
  - On a fleet with no Discord or Telegram connection, the sign-in page says "On the AgEnD computer, run `agend web --code` to get a sign-in code." A wrong code says how to get a new one the same way. The "No chat bot?" help is hidden, because there is no /web to send.
  - `agend quickstart`, `agend setup` and `agend init` end with only that sign-in line on such a fleet.
  - The README, the getting-started guide and `install.sh` say quickstart is web only by default and a bot token is optional.
  - Fleets with a chat connection are unchanged.
