---
section: Changed
---
- **The task board's chat surfaces are off by default.** If your fleet never set these, they are now off:
  - **Daily summary.** To turn it back on, set a time: `defaults: { task_board: { summary_at: "09:00" } }`.
  - **Task-board cards in Needs you** (General's live message and the dashboard's Needs-you panel). To turn them back on, set `needs_you: { task_board: true }`.

  A fleet that already set either one keeps its setting. The other Needs-you items (prompts, deliveries, sign-in and crash notices) are unchanged (#2425).
- Needs you no longer posts its message again every minute for cards that have not changed. A card without a "moved to blocked" record, which is every card the `task` tool kept before the board, took its waiting time from its last edit. So each edit by its agent looked like a new item and was posted again at the bottom (#2425).
