---
section: Changed
---
- Agents on Codex, Kiro, Grok, Muse, Antigravity and OpenCode no longer get "[system] Your AgEnD instructions have been updated. Reload only …" pasted after a restart. It fired whenever anything in their instructions changed, such as a newly posted decision, and cost the agent a turn each time. The new instructions are still written to the agent's instruction file at every start and take effect when the CLI next reads it. Claude Code agents never got this notice and are unchanged.
