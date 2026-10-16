---
section: Fixed
---
- **The web chat's `/compact` now says when it is done (#1269).** The card used to say "Compact command sent" forever.
  - From the moment the command reaches the agent it says **Compacting…**, then **Conversation compacted** once the agent's own record of it appears, and leaves. This works on Claude Code, Codex and kiro (Classic, and the TUI's V2 engine); the kiro Log shows the compaction too.
  - Other backends, and kiro V3, write no record AgEnD can read, so the chat says their compaction end can't be detected instead of claiming it finished.
  - With no record within 10 minutes, the chat says so instead of waiting forever. If the command never reached the agent, or the agent stopped, restarted or changed backend meanwhile, it says it can't follow the compaction.
  - `/clear` and `/cancel` answers that only say the command was sent now leave by themselves. A refusal stays.
