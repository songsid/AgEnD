---
section: Fixed
---
- **An agent with the task board off is handed no cards.** It has no `task` tool, so a card assigned to it sat unread while the board kept sending it notices it could not act on. Now the board refuses it as a card's (or a `task`-tool task's) new assignee — from the dashboard and from other agents — with the reason; the dashboard's assignee pickers grey it out (**name (task board off)**), and it gets no task board notices. Cards it already had stay assigned to it; switching its task board on tells it to start with `task mine`.
