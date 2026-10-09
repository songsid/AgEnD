---
section: Fixed
---
- View and status context refreshes reuse each instance's tmux control read lane, removing the per-instance capture subprocess when control is connected. Pending results are fenced across stop, respawn, pane replacement and cancellation.
- Cache a successfully verified OS home for the current user to avoid repeated password-database lookups in tmux namespace getters. Failed lookups remain unknown and never trust `$HOME`.
