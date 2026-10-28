---
section: Changed
---
- Fewer reply reminders. An agent that ends its turn without answering a request is still reminded once per request (`[system:reply-pending]`); that is now the only one. Gone: the batch reminder after a restart (the agent gets the ordinary reminder once it is idle, unless it was already reminded), the asker's "has not replied" and "expired" notices, the "accepted before the restart" notice to a restarted sender, and the "⚠️ Still no confirmed reply after one retry" line in the topic and web chat (the Log tab still records it). A failed or unconfirmed message to another agent is still reported to its sender. `defaults.reply_overdue_minutes` no longer does anything; it is still accepted (and checked as before).
