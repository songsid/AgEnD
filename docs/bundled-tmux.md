# AgEnD's own tmux

[繁體中文](bundled-tmux.zh-TW.md)

AgEnD runs every agent in a tmux window. From this release it brings its own tmux and runs it on its own socket. It no longer uses the `tmux` installed on the host. (Design: [docs/design/bundled-tmux.md](design/bundled-tmux.md).)

## What changes for you

- **`tmux attach` no longer shows the agents.** The host's `tmux` talks to its own default server, and AgEnD's server is not that one. Use:
  - `agend attach [name]` to look at an agent's window;
  - `agend tmux <args…>` for any other tmux command on AgEnD's server, for example `agend tmux ls` or `agend tmux capture-pane -p -t agend:<name>`.
- **Your `~/.tmux.conf` no longer applies to AgEnD's server.** AgEnD reads only its own `~/.agend/tmux/agend-tmux.conf`, so your key bindings and plugins can't change how messages reach the agents.
- **The first start on this version posts one notice** in General (or the dashboard's Notices) saying the same.
- `agend doctor` shows which tmux AgEnD runs and on which socket.

## Where it comes from

The tmux is one of four npm packages, `@songsid/agend-tmux-<os>-<cpu>` (Linux and macOS, x64 and arm64). They are optional dependencies of `@songsid/agend`, installed from your npm registry like the bundled Node. Each package's tmux is built from pinned, checksummed sources, and the build is reproducible. When AgEnD is installed, it runs that tmux once (its version, its checksum, a start and stop on a throwaway socket) before the install is accepted. If the check fails, npm keeps the version you had.

The package's tmux is copied to `~/.agend/tmux/<version>-<hash>/`, and the server runs from that copy, so an update never replaces the binary under a running server.

**There is no fallback to the host's tmux.** If this platform has no package, or the package was left out (`npm install --omit=optional`, or a registry mirror without it), AgEnD refuses to start and says so. To run anyway on such a host, set `AGEND_TMUX_BIN` to the absolute path of a tmux 3.6a or newer.

**Offline hosts.** On a connected machine, run `npm pack @songsid/agend @songsid/agend-tmux-<platform> @songsid/agend-node-<platform>`. Then, on the offline host, run `npm install -g ./*.tgz`.

## Upgrading from an earlier version

Nothing to do. On its first start the new version finds the agents' old windows on the host tmux's default server, closes them after saving each conversation, and starts every agent on its own server.

- An old window it can't prove belongs to that agent is left alone, and only that agent waits. Needs-you names it: close the window, or run `agend tmux-migrate --release <name>` to say you will handle it yourself.
- AgEnD never stops the host tmux's default server, because it can hold your own sessions.
- The host's tmux stays installed. AgEnD no longer uses it, but a rollback to an earlier version needs it.

## Going back to an earlier version

Use `agend rollback <version>`, for example `agend rollback 2.3.4`. It stops the fleet, closes AgEnD's own tmux server, confirms the server is gone, and only then installs the older version and starts it. If the close can't be confirmed, it stops before installing anything and says what is still running.

A plain `npm install -g @songsid/agend@<older>` skips those steps.

- **Linux with systemd (and WSL):** this is still safe. The service restart ends AgEnD's server.
- **macOS, or a fleet started in the foreground:** AgEnD's server can keep running, and the older version can't see it. Its agents would then run twice. This path is not supported. A recent 2.3.x refuses to start agents while that server answers, and points you to `agend rollback`.
