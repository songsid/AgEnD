---
section: Added
---
- **The chat's activity timeline for Antigravity and Grok instances (#3648).** With the Log on, an Antigravity (`agy`) or Grok instance now has what Claude Code and Codex have: the Log tab's steps and, above each reply in the chat, its thinking, the text it said on the way and its tool calls. AgEnD reads each CLI's own record — Antigravity's conversation transcript and Grok's session `updates.jsonl` — and ties each step to its reply by the ids in them. Thinking follows the same rule as before: only a signed-in admin on this dashboard gets it (`web.log_thinking`). Also fixed: a tool result that the Log's live read picked up after its call was read earlier could be shown as interrupted when the turn ended.
