---
section: Fixed
---
- **In a Telegram instance topic, a command that only works in General now says so, instead of reaching the agent
  (#1148).** The forum group's command menu is the same in every topic, so `/status`, `/sysinfo`, `/dashboard`,
  `/restart`, `/update`, `/profile`, `/doctor`, `/login`, `/usage` and `/visibility` are offered in instance topics too.
  Chosen there, they used to be passed to the agent as ordinary text: nothing ran, and nothing said why. They now
  answer "works in the General topic — please use it there". In General they work as before.
