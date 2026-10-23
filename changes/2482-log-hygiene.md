---
section: Changed
---
- **daemon.log is about 60% shorter, with nothing incident-relevant lost (#2482).** Every agent turn used to log two "execution state changed" lines and two Cancel-button lines; they are now debug level (a change into or out of "stuck" is still logged). A paused instance is no longer reported as "New instance in config — starting" on every reload. The warning about your own skills shadowing bundled ones is one line per folder, and only when that set or its content changed, not on every start. And after a Discord stop, the failed message edits are one line, not one per edit. Replayed on a real day's log: 72,824 → 27,260 lines, with every watchdog, crash, auth and delivery-failure event kept.
