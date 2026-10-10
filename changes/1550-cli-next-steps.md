---
section: Changed
---
- **CLI: setup ends by pointing to the web dashboard (#1550).** `agend quickstart`, `agend setup` and `agend init` now end with the dashboard's address (`http://localhost:19280/`, or the fleet's `health_port`). They also say how to sign in: run `agend web --code`, or send `/dashboard` to your bot. Quickstart's steps are numbered 1/4 to 4/4. When `agend init` installs the service, it now also starts it; it used to suggest a `systemctl` unit that does not exist. Its "install the Discord plugin" line is gone, because Discord is built in. A successful `npm install` ends with "Next: run `agend quickstart`". The README and the website's getting-started page now give the right Node requirement and describe the dashboard.
