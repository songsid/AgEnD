---
section: Fixed
---
- **The web chat's `/compact` now says when it is done (#1269).** The chip used to say "Compact command sent" forever.
  - It says **Compacting…**, then **Conversation compacted** once the instance's transcript records it, and then leaves. This works on Claude Code and Codex.
  - Other backends write no record AgEnD can read, so the chat says their compaction end can't be detected instead of claiming it finished.
  - With no record within 10 minutes, the chat says so instead of waiting forever.
  - Answers that only say a command was sent (`/clear`, `/cancel`, `/btw`, `/steer`, `/pause`, `/wake`, `/save`) now leave by themselves after a few seconds.
