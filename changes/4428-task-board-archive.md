---
section: Changed
---
- Fleet › Tasks: a project's Done column now shows its newest 20 finished cards ("Show N more" shows the rest), with how many were done this week, and how many of those are archived, under its title. Finished and cancelled main tasks are archived 3 days after they finish (Settings › Shared agent settings › Advanced › "Archive finished cards after", `defaults.task_board.archive_after_days`; 0 keeps them on the board): they leave the columns and the project's numbers, the project's "Archived · N" opens a list of them, search marks them, their number still opens them, and moving one back to To do reopens it. Nothing is deleted.
