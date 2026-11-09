---
section: Fixed
---
- **Telegram updates remain pending while the fleet shuts down.** Polling stops before Agents stop, while outbound shutdown notices can still be sent. Late updates do not advance the local update floor or acknowledge Telegram's queue; the next start receives them normally.
