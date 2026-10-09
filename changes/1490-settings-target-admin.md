---
section: Security
---
- **Settings confirmation follows the affected bot's permissions:** a chat
  confirmation requires admin membership on every existing target connection;
  another General's admins cannot approve it just because the buttons appear
  there. Fleet-wide changes and new connections retain the configured primary
  General's admin authority; mixed changes require both. Shared token aliases
  include every affected connection. Cross-platform or unknown targets require
  `agend settings confirm <id>` on the host. Browser pending/retry behavior and
  first-time Setup host confirmation remain available. (#1490)
