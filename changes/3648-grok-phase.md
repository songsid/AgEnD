---
section: Added
---
- **Grok's live line in the chat says where Grok is (#3648).** While a Grok instance works, the chat's "Working…" line now reads "Reasoning…", "Running a tool…", "Waiting for permission…" and so on, from Grok's own `events.jsonl` (a signed-in admin on this dashboard only; only the phase is read — nothing else in that file leaves the server). A phase AgEnD does not know keeps the plain "Working…". It does not read the screen.
