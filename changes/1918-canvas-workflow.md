---
section: Changed
---
- **The org canvas shows the work, not just the message (#1918).**
  - **Delegations stay until their report.** A `delegate_task` draws a slow-moving line from the delegator to the worker that stays **in progress** until the worker's `report_result` with the same correlation id comes back. Then one line returns to the delegator, and it goes. With no report after 4 hours it fades as **no report yet**. A reload or the public link shows the open ones too.
  - **Messages stay long enough to see.** A delivered or read message now fades over 12 seconds, instead of vanishing as soon as it was read (an agent reads one almost at once). The key explains the new lines.
  - **Fixed: a line that touched no card.** Two cards in the same box were joined through the space above the box, which could draw a lone vertical line. They are now joined inside the box, and every line ends on a card or a folded team's box. Team headers stay readable above the lines.
