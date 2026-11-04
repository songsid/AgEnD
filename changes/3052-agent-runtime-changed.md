---
section: Changed
---
- Runtime uses consistent cards for local and paired Windows computers. CLI diagnostics open in a computer-specific dialog, with optional test tasks collapsed by default. Closing and reopening preserves drafts and submitted task ownership.
- Runtime CLI diagnostics can select a paired Windows computer, with separate inventory, working directory, models and test-task history for each computer. Offline computers retain cached inventory and reject new tasks.
- Runtime settings now show the Windows computer name beside the local CLI summary and diagnostics. The name is reported by the Windows worker during explicit detection and retained with its inventory; older inventories show an unreported name until detection is refreshed. Diagnostics and test tasks are labelled as using the AgEnD host's Windows CLIs.
