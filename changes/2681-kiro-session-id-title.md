---
section: Changed
---
- **After a kiro TUI or V3 launch, AgEnD types `/session-id` and `/title` (#2681).** `/session-id` is compared with the conversation this launch resumed by id. A mismatch is shown; AgEnD never guesses another conversation from files. `/title` is set to the instance name, so attaching to the pane shows which instance it is. The legacy UI is unchanged (tmux window name).
