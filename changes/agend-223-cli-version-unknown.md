---
section: Fixed
---
- **Antigravity and Grok cards no longer say "? is installed" when run in a container.** Where the host cannot make a network namespace (a Docker container: `unshare -rn` is refused), AgEnD never ran `agy --version` or `grok --version`, so the version stayed unknown for ever. For those two CLIs, which keep no version on disk, `--version` now runs directly (still with the no-update switches, a memory cap where systemd allows one, and a 5 s deadline). Other CLIs keep the strict rule. A version that still cannot be read now says "The installed version could not be read" for Antigravity too, instead of "? is installed".
