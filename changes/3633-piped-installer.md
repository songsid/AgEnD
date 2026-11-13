---
section: Fixed
---
- **The Linux installer completes when run through `curl | bash` (#3633).** Package managers and Node setup no longer read the remaining script as input. Debian/Ubuntu package installs run non-interactively, and installation fails clearly if `agend --version` cannot run from PATH.
