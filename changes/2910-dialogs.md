---
section: Added
---
- **A web-only fleet answers its agents' dialogs from the dashboard (#2910).** A Claude Code or Codex dialog that AgEnD leaves for a person now appears in the agent's chat and in **Needs you**. It shows the dialog's own words and its options as buttons, and your choice is keyed into the terminal on a checked cursor. This covers:
  - a Bash, Edit, Write or MCP tool permission (with `skipPermissions: false`);
  - an unrecognised trust or Bypass Permissions screen;
  - "Background work is running";
  - a "Switch model?" AgEnD did not ask for;
  - Codex's held selections.

  Escape is never offered. A password or sudo prompt in a terminal becomes a Notice pointing to the agent's View. Fleets with a chat connection are unchanged.
