---
section: Fixed
---
- **The web chat's `/compact` now says when it is done (#1269).** The card used to say "Compact command sent" forever.
  - From the moment the command reaches the agent it says **Compacting…**, then **Conversation compacted** once the agent's transcript records it, and leaves. This works on Claude Code and Codex.
  - Other backends, kiro included, write no record AgEnD can tie to the instance, so the chat says their compaction end can't be detected and leaves, instead of claiming it finished or staying forever.
  - With no record within 10 minutes, the chat says so instead of waiting forever. If the command never reached the agent, or the agent stopped, restarted or changed backend meanwhile, it says it can't follow the compaction.
  - `/clear` and `/cancel` answers that only say the command was sent now leave by themselves. A refusal stays.
