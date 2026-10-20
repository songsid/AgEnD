---
section: Added
---
- **Sign a backend CLI in from the web dashboard, with no chat connection (#2233).** A fleet admin signed in to the dashboard on this machine or its network can sign Claude Code, Codex, Kiro CLI or Grok in without Discord or Telegram:
  - **Settings → Agents → Sign-ins** lists each backend's login and each credential profile an agent uses, with **Sign in**;
  - the web `/backend` picker offers **Sign in to <backend>** next to a backend that is not signed in;
  - **Needs you** offers **Sign in** on an agent paused for sign-in.

  It is the same flow as `/login`, with the same checks and 10-minute window. A device code shows in the dialog; a browser-terminal login shows its link and one-time access code to that browser session only, instead of a DM. While it runs, every admin page shows it, and the browser that started it is the only one that sees the code. It is never offered to a guest or over the public link, and a sign-in whose browser session ends is cancelled.
