---
section: Fixed
---
- Web chat: **Retry send** never delivers a message twice (#2440). When a message did reach the agent but its answer was lost on the way back, the chat showed it as not sent, and Retry sent it again. The server now recognizes the repeat for 10 minutes and answers with the first message, so the agent gets it once.
