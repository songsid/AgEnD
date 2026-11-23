---
section: Changed
---
- Agents are told once, plainly, what needs a go-ahead: only a release or publish, anything destructive or irreversible beyond the agent's own work, spending money or quota beyond normal work, credentials or secrets, and granting or forwarding authority. Reading, querying, analysis, status and logs, and the routine operations of the agent's own domain need no receipt, button or verification. The checks for those five are unchanged. Codex agents still ask before changing what others use outside their own domain (#4342).
- **Owner and routine operations** (Settings → the agent → Basic info; `operations` in fleet.yaml): an optional note on who owns the system the agent works on and which operations are routine there. The agent reads it right after its role, as context; it never approves any of the five go-ahead actions. Template export leaves it out unless you tick it (#4342).
- **Details → Loaded every session** lists the files the agent's CLI reads at the start of every session, with their sizes and the total, and warns when a file is over 50 KB, or when Codex's `AGENTS.md` is over the 32 KB Codex reads (#4342).
