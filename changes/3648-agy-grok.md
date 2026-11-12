---
section: Added
---
- **The chat's activity timeline for Antigravity and Grok instances (#3648).** An Antigravity (`agy`) or Grok instance now has what Claude Code and Codex have: the Log tab's steps (with the Log on) and, above each reply in the chat for a signed-in admin, what it did — following the agent's own `tool_progress` — its text on the way and its tool calls. AgEnD reads each CLI's own record — Antigravity's conversation transcript and Grok's session `updates.jsonl` — and ties each step to its reply by the ids in them. Thinking follows the same rule as for them: off by default (`web.log_thinking`), and only a signed-in admin on this dashboard gets it.
