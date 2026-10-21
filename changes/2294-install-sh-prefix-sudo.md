---
section: Fixed
---
- **The install one-liner no longer asks for sudo when the configured npm prefix does not exist yet (#2294).** It used to treat a missing prefix (for example `~/.npm-global` with no `lib/`) as unwritable and fall back to sudo, which then failed without a terminal on Linux and stuck a non-admin account on macOS. It now judges writability from the nearest existing parent: if that directory is writable, or the prefix is under the user's home, it creates the missing directories. After that it picks sudo from whether `lib/node_modules` or `lib` is writable, so a writable prefix does not override an existing unwritable `lib`. A system prefix the user cannot write still uses sudo.
