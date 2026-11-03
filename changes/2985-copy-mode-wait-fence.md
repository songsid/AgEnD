---
section: Fixed
---
- **A delivery's Enter that waits out a pane left in copy-mode never lands in a restarted CLI.** The wait can last up to 10 minutes. A respawn or relaunch reuses the same tmux window, and the beta.5 revert (#2985) had dropped the check that tells the CLI the message was pasted into from its successor. The Enter is now dropped when the agent's CLI was restarted during the wait. (M-2290, #2985 follow-up)
