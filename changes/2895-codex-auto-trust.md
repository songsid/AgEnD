---
section: Changed
---
- Codex agents no longer block on Codex's "Trust this folder?" prompt. AgEnD auto-trusts the agent's workspace: it presses Trust when the prompt shows with the cursor on Trust, whether or not the folder was pre-trusted. Only the folder-trust prompt is answered; approvals for commands still wait for a person when `skipPermissions` is false. daemon.log records what was trusted. A trust prompt in an unfamiliar layout is still held.
