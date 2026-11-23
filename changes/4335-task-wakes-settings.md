---
section: Added
---
- **The task board's wake switches are in Settings.** Settings → Shared agent settings → Advanced has a new card, "When the task board wakes an agent", next to "When an assignee stops": "Comments wake agents" (`defaults.task_board.comment_wakes`), "Progress wakes whoever follows a card" (`progress_wakes`) and "Board leader" (`leader`, a menu of the fleet's agents). Each switch has a line that says what stays asleep when it is off. The fleet reads them at every card change, so a change applies to the next one. Saving writes only what you changed (a switch nobody touched is not added to fleet.yaml, and any other `task_board` key stays), and the leader's name shows in the confirmation.
