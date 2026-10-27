---
section: Changed
---
- A message from one agent to another that is still waiting to be delivered is replaced when a newer message from the same sender, on the same thread (correlation_id), is queued behind it. For example, several review rounds for a PR that waited while the agent was busy now arrive as the latest one only, not all of them in a row. The replaced message shows as cancelled, superseded by the newer one, in `delivery_status`. Agents are asked to keep one correlation_id per PR or task. Schedules, system notices and people's messages are not affected.
