---
section: Security
---
- **A remote confirmation that opens a link or changes a secret posts a Notice (#3486).** When a change that opens a public link, or changes a secret, is confirmed from another device, the owner gets a Notice (the dashboard's Notices on a web-only fleet; General, else the primary connection, else the web Notices on a chat fleet), besides the audit entry. `docs/SECURITY.md` now states the remaining risk plainly: until the owner turns on the code option or "Only this computer can authorize", a signed-in admin session can make any change, including opening a link.
