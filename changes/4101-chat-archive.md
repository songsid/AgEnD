---
section: Added
---
- Web chat: messages that leave an agent's last 500 are now kept in an archive on the host (text, author, time and file names; old buttons and polls read-only) instead of being dropped, ready for scrolling back. `web.chat_archive.retention_days` limits how long it keeps them (by default it keeps everything); an agent's archive is removed with the agent.
