---
section: Changed
---
- Switching a Claude Code instance to another credential profile no longer promises a cold cache. The reply's `conversation_note`, the docs and the credential-profiles skill now say the switch does not by itself empty the prompt cache: within the same cache scope (organization, and workspace where the provider isolates them) an unchanged model and prompt prefix are usually reused, and the next turn may rebuild it at full price when the scope, the model or the profile's settings differ, or the cache has expired.
