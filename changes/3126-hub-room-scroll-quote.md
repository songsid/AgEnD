---
section: Fixed
---
- **Hub rooms: older messages and a quote jump (M-3126).** Scrolling up in a room loads the next older page (the server already pages with `before=`). A first page that does not fill the window also loads the next older page (a tall room parked at the bottom still does not fetch the whole history). A quote of a message not in the latest 50 still shows a chip; clicking it loads up to that original and jumps to it. A room ask that failed or was blocked shows the Fleet ticks **!** / **⊘** and a short reason. The Hub names optional `ask.failed` / `ask.blocked` (zeros omitted) and, for a single settled miss, `ask.reason` (`expired`, `retired`, `unavailable`, `interrupted`, or `unknown`). Older clients keep seeing queued / sent / answered as before.
