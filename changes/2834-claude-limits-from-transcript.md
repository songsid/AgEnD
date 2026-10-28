---
section: Fixed
---
- A Claude Code agent is no longer paused, or told it hit a usage limit, because text on its screen mentions "credit balance is too low" or "Usage limit reached · continuing automatically …" (for example the agent quoting it). AgEnD now takes both from Claude's own record of the error. A real usage-limit pause gives the same notice as before. A real out-of-credits error now pauses the agent on Claude Code 2.1.312 as intended; the old screen check never matched that version's "Credit balance too low · Add funds…" line.
