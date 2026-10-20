---
section: Fixed
---
- **Claude Code 2.1.304: an idle agent's "Resume this conversation?" prompt is answered again, not held (#2268).** In 2.1.304 the prompt's idle form labels Escape "Esc to dismiss" instead of "Esc to resume". The key does the same thing in both: it closes the prompt and keeps the conversation. AgEnD only recognised "Esc to resume", so it held the prompt for a human and blocked deliveries to that agent. It now answers Escape for both labels, as before. A screen of any other shape is still held, and AgEnD never chooses "Start a new conversation".
