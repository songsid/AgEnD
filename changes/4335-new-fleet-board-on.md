---
section: Changed
---
- **A new fleet has the task board on.** `agend init`, `agend quickstart` and the setup page used to write `defaults.dashboard.task_board: false`, so a new user who opened the board found that comments and `#` references did nothing, with no word of why. A new `fleet.yaml` now says nothing about the board, which is on; an existing file is never rewritten and a `false` in it stays. Where an agent has the board off, the Tasks page names it and where to turn it on (Settings → Shared agent settings, or the agent's own Settings → Advanced), a card's comment box says when a comment would not wake its assignee or an @mentioned agent, and a `#` reference sent to such an agent says in the chat that the card was not handed over.
