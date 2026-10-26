---
section: Changed
---
- **After a kiro TUI or V3 launch, AgEnD types `/session-id` and `/title` (#2681, #2684, #2683).** Each command goes only into an empty input box, never into a draft. AgEnD presses Enter only once the box shows exactly that command, and it types nothing more if the command stays in the box. `/session-id` is compared with the conversation this launch resumed by id. Only kiro's own answer to this command counts: a `Session ID:` line that was already on screen, or one quoted in the chat, does not. A match is recorded as proven. A mismatch is shown; AgEnD never guesses another conversation from files. `/title` is set to the instance name, which kiro applies when its terminal title is enabled (`/settings display`). The legacy UI is unchanged (tmux window name).
