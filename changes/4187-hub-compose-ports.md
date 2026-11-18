---
section: Fixed
---
- **Hub integration test listener ports (#4187).** Keep the member and web sockets reserved until their real listeners take over, preventing the compose rig from choosing the same address twice.
