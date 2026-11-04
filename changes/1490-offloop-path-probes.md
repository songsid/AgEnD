---
section: Fixed
---
- **The fleet no longer walks PATH with a synchronous `accessSync` when starting tmux or wrapping a `/login` install (#1490).** The login shell and the tmux/stty helper now use the existing off-loop PATH probe (a child that can be killed). A missing or unknown answer keeps the inherited `$SHELL` and sends tmux/stty direct, as before.
