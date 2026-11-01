---
section: Fixed
---
- A web-only fleet (no Discord or Telegram connection) runs whole:
  - Schedules, the task board and fleet decisions work.
  - Agents can message each other (`send_to_instance`, `delegate_task`, `report_result`, `broadcast`).
  - **New agent** in the dashboard creates an agent with no chat topic.
  - `edit_message` and `download_attachment` now say they are not available on a web-only fleet, instead of asking the agent to retry.
  - Every start path decides the agent mode the same way, so restarting from the dashboard or the CLI on a fleet with several connections no longer loses cross-instance messaging.
