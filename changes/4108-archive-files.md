---
section: Added
---
- Web chat: archived messages keep their files and pictures. They are kept in the agent's chat archive, and all agents' archived files together stay within `web.chat_archive.files_max_gb` (default 5 GB; the oldest are removed first, and their messages then show the file as no longer kept). `web.chat_archive.retention_days` removes a month's files with its messages. A file the web chat still shows is no longer removed by the 7-day inbox cleanup.
