---
section: Fixed
---
- **Discord, Telegram and the web chat no longer show internal message ids on cross-instance notices (#3056).** `hmsg-` / `xmsg-` ids, a `verification_id` / `message_id` label, a `(verification_id …)` parenthetical, and `forwards: […]` lists are stripped from the topic line, the Mirror Topic, and the web chat's status line. The receiving agent still gets the original text and `forwards` field, unchanged. SHAs, PR numbers and URLs stay.
