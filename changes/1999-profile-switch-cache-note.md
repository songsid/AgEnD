---
section: Changed
---
- Switching a Claude Code instance to another credential profile no longer promises a cold cache. The reply's `conversation_note`, the docs and the credential-profiles skill now say the next turn may be re-read at full price only when the two profiles belong to different organizations or the prompt cache has expired; within the same organization the cache usually carries over.
