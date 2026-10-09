---
section: Changed
---
- **`agend` and `agend-agent` start through a small launcher that picks the Node AgEnD runs on (#1450).** When a
  release pins AgEnD's own Node for this platform (Linux glibc ≥ 2.28 x64/arm64, macOS 11+ x64/arm64), the install
  verifies that Node — its exact version, N-API 10, and a database opened in the main thread and in a worker — and
  records it. From then on AgEnD runs on it, whatever Node is on your PATH. Your system Node, PATH and npm stay as
  they were.
  - A bundled Node that is missing, incomplete or changed after it was verified is refused, with the command that
    repairs it. AgEnD never falls back to another Node silently.
  - If the bundled Node was skipped at install (`--omit=optional`, `--ignore-scripts`), AgEnD uses your Node when it
    qualifies, and says so.
  - `AGEND_NODE=/abs/path/to/node` overrides the choice. It must be a Node AgEnD supports; otherwise AgEnD refuses
    instead of falling back.
