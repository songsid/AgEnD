---
section: Changed
---
- **`agend` and `agend-agent` start through a launcher that picks the Node AgEnD runs on (#1450).** The commands are
  small POSIX `sh` scripts, so they start even with no `node` on PATH, for example in a shell that has not loaded nvm.
  When a release pins AgEnD's own Node for this platform (Linux glibc ≥ 2.28 x64/arm64, macOS 11+ x64/arm64), the
  install verifies that Node: its exact version, N-API 10, and a database opened in the main thread and in a worker.
  It then records it, and from then on AgEnD runs on it whatever Node is on your PATH. Your system Node, PATH and npm
  stay as they were.
  - A bundled Node that is missing, incomplete or changed after it was verified is refused, with the command that
    repairs it. AgEnD never falls back to another Node silently.
  - If the bundled Node was skipped at install (`--omit=optional`, `--ignore-scripts`), AgEnD uses your Node when it
    qualifies, and says so.
  - `AGEND_NODE=/abs/path/to/node` overrides the choice. It must be a Node AgEnD supports; otherwise AgEnD refuses
    instead of falling back.
  - What AgEnD starts for itself runs on the Node it is running on and on its own CLI file, never a `node` or `agend`
    found on PATH: the MCP server the coding CLIs start, `agend start` and `agend restart` without a service, the
    quickstart reload, `/doctor`, and the Antigravity status line. Paths and arguments in the generated kiro, grok and
    muse wrappers are quoted, so a path with spaces, `$` or backticks is used exactly as written.
  - Native Windows is not supported: run AgEnD inside WSL.
