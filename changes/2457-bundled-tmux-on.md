---
section: Changed
---
- **AgEnD runs its agents in its own tmux (M-2457).** AgEnD now brings its own tmux 3.8 as an npm package, `@songsid/agend-tmux-<os>-<cpu>` (Linux and macOS, x64 and arm64), and runs it on its own socket, `agend`.
  - **`tmux attach` no longer shows the agents.** Use `agend attach [name]`, or `agend tmux <args…>` for any other tmux command on AgEnD's server. Your `~/.tmux.conf` no longer applies to it.
  - **Install checks.** The package's tmux is checked when AgEnD is installed (version, checksum, a start and stop on a throwaway socket). If the check fails, npm keeps the version you had.
  - **No fallback to the host's tmux.** A host without the package refuses to start and says why. Set `AGEND_TMUX_BIN` to a tmux 3.6a or newer to run anyway.
  - **Upgrading.** The first start closes the agents' old windows on the host tmux after saving each conversation, never the host tmux's server itself, then posts one notice saying all this. An old window it can't prove is that agent's holds only that agent; `agend tmux-migrate --release <name>` releases it.
  - **Going back to 2.3.x: `agend rollback <version>`.** It closes AgEnD's own tmux server and confirms it is gone before it installs the older version. A plain `npm install -g` of an older version is safe only on Linux with systemd.
  - See [AgEnD's own tmux](../docs/bundled-tmux.md).
