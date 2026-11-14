---
section: Fixed
---
- **Hub rooms: older messages and a quote jump (M-3126).** Scrolling up in a room loads the next older page (the server already pages with `before=`). A quote of a message not in the latest 50 still shows a chip; clicking it loads up to that original and jumps to it. A room ask that failed or was blocked shows the Fleet ticks **!** / **⊘** and a short reason when the server names `ask.failed` / `ask.blocked` (or when a stored answer is `not-answered`).
