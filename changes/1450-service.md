---
section: Changed
---
- **The service names AgEnD's own Node, and `agend restart` refuses a service it cannot prove (#1450).**
  - The systemd unit and the launchd plist now start `<AgEnD's Node> <package>/dist/cli.js fleet start`, instead of
    leaving Node to `#!/usr/bin/env node` and the service's PATH.
  - Before stopping anything, `agend restart` checks that the definition systemd or launchd has loaded starts exactly
    that, with no reload pending. Otherwise it refuses and stops nothing; run `agend install` to rewrite an older
    service. `--force` is for operators.
  - macOS: `agend install --no-activate` no longer leaves a new plist for launchd to pick up at an arbitrary moment. It
    proves the plist and records a planned activation, and the next `agend restart` performs exactly one
    `bootout`/`bootstrap`, rolling back to the previous job if the new one does not run. See `docs/cli.md` for the
    launchd domain AgEnD uses (`gui/<uid>`) and why.
