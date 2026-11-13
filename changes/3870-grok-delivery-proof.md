---
section: Fixed
---
- **Grok no longer says "Could not confirm delivery" for messages it took.** Grok shows a sent message as three rows and a `…`, so the message id at the end of a short fleet message never appeared on screen. AgEnD now confirms the message by its delivery marker on the first row, or in Grok's queue when Grok is busy. A long paste's preview card counts as the unsent draft. Before, a paste whose Enter was lost could be confirmed from that card.
- **Needs you lists only delivery problems someone must act on.** AgEnD's own notices (reply reminders, delivery outcomes) and broadcasts are no longer listed. An unconfirmed message whose later proof arrives clears itself: Claude Code and Codex now watch their transcript for a message they could not confirm at once, as Grok already does.
