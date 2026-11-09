---
section: Fixed
---
- **A clean CLI exit waits briefly for tmux's exit status (#3037).** When a terminal closed before its exit code was available, Claude's `/exit` could enter crash recovery instead of offering Restart. AgEnD now rechecks the status before deciding, and checks MCP revival only for a live CLI. A missing or nonzero status is never guessed to be a clean exit.
