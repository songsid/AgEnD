---
section: Added
---
- **Web chat: the conversation is still there after AgEnD restarts (#1565).** The latest 500 messages of each agent are kept on this computer, in a private file in the agent's workspace (`workspaces/<name>/web-chat.json`), and come back when the fleet starts again. A page left open across the restart shows each message once. Files in those messages still open after the restart — as long as the file is still in the agent's inbox and unchanged; otherwise its name is shown as unavailable. Buttons and delivery ticks are not kept. Deleting an agent deletes its file.
