---
section: Changed
---
- A message from one agent to another carries less fixed text. When it needs no answer, the "If you need to reply…" line under it is gone. When an answer is owed, the separate "A reply IS required…" line becomes a short marker at the end of the header line: `reply required → report_result <correlation id>` (in CLI mode, the `agend-agent report` command). The header no longer shows `request_kind`; Fleet traffic and the logs still record it. Messages from people are unchanged.
