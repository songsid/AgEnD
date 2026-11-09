---
section: Security
---
- **Security Notices for remote confirmations and authenticator changes (#3503, #3486).** A change that opens a public link or changes a secret, confirmed from another device, posts a Notice. So does every set-up, replacement or removal of an admin's authenticator and every switch of "ask for my code" on or off, naming the admin, from anywhere. They go to every connection's General and always to the dashboard's Notices, so a failed chat send still leaves the Notice. `docs/SECURITY.md` states the per-admin model and the remaining risk plainly: until an admin turns on their own switch or the owner turns on "Only this computer can authorize", a signed-in admin session can make any change, including opening a link.
