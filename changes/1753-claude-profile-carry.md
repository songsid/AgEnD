---
section: Changed
---
- **Switching a Claude Code agent's credential profile keeps its conversation (#1753).** Until now, a switch started a fresh conversation and gave the new session a short handover. Now AgEnD copies the session's transcript, its folder and its file history into the new profile while the agent restarts, and the agent picks the conversation up there.
  - The old profile keeps its own copy, so switching back returns to the same conversation.
  - The first reply after the switch re-reads the conversation from a cold cache, so it is slower and billed at full price.
  - This applies to `update_instance_config` and to ClassicBot channels.
  - If the copy can't be made, the switch starts fresh with the handover as before, and the reply gives the reason in `carry_failed`. That happens when there is no session yet, when the new profile already holds a different version of that conversation, when there isn't enough disk space, or when the copy fails.
  - Kiro still starts fresh, and Codex never lost the conversation.
