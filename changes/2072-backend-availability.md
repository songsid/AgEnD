---
section: Changed
---
- **`/backend` and the create-instance dialog show every backend, with why one cannot run here (#2072).** A backend this host cannot use is shown disabled with its reason: not installed, not signed in (use /login), or older than AgEnD supports. One not checked yet stays selectable, and the backend an instance already runs is never disabled. On Discord a select menu cannot disable an option, so the reason is in its label and choosing it says why.
  - The answers come from a snapshot the fleet refreshes in the background: at start, every 10 minutes, and after a `/login` install or sign-in. A pass that finds nothing changed starts no CLI.
  - Sign-in is read offline from the CLI's own credential files, never with an API call. A CLI is never started where it could update itself or reach the network: its version is read from disk where it is written there, else (Linux) `--version` runs with no network, else it stays unknown.
  - The pickers, ClassicBot `/start` and the setup wizard no longer run `which` on the fleet's event loop.
