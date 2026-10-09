---
section: Fixed
---
- **A window the fleet can no longer resolve is not treated as idle (#1490):** after three failed `tmux list-panes` for a registered window, the control client used to forget the window, and an unknown window counted as idle once the reconnect grace was over. A delivery could then paste into a CLI that was still generating, where Enter interrupts it. Such a window is now kept as lost and reported busy; asking about it retries the lookup at most every 5 seconds, and once it resolves it is registered again and counts as idle only after 2 seconds of observed silence. A registered window whose pane is not resolved yet after a reconnect is also busy until it resolves. Windows that were never registered keep the previous behaviour.
