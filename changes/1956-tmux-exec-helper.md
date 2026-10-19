---
section: Fixed
---
- The fleet's tmux and stty commands (message delivery, `/view`, window and session changes) are started by a small helper process instead of the fleet itself (#1956), so the fleet's event loop no longer stalls on the fork of its own large process for each one. With the fleet at 550 MB, a tmux command held the loop about 26 ms; now about 0.4 ms. A command is never run twice: if the helper is wedged or dies, a command it never started runs directly, and one it started fails the way a timed-out command always has.
