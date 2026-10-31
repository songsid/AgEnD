---
section: Fixed
---
- When a Codex agent is held on Codex's "Trust this folder?" prompt, daemon.log now says once why AgEnD did not answer it: the folder Codex asks about against the folder AgEnD trusted, and whether the agent's Codex config trusts it. The "startup dialog held" line now appears for every held prompt; it was skipped for prompts that also block deliveries.
