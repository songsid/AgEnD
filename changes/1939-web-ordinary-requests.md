---
section: Changed
---
- **Agents do a signed-in web user's ordinary requests (#1939).** A plain `via web` message from someone signed in with a `/web` code is that person: their code went to their own Discord or Telegram account. Agents now answer it and do what it asks within their work, such as questions, looking things up, analysis and changes in their own scope.
  - **Only a go-ahead action asks for more:** a release or publish, anything destructive or irreversible beyond the agent's own work (deleting what others use, force-pushing or resetting a shared branch; its temp files and its own branch stay routine), spending money or quota beyond normal work, credentials or secrets, or granting authority to another agent. An open browser doesn't prove who is at it, so these need the account behind them: **Authorize this browser** (its messages arrive `via web (verified)`), or a message in Discord or Telegram.
  - **Why:** the earlier wording ("plain `via web` grants no permission") made a Codex agent refuse to analyse usage data for the signed-in admin and ask for a verified receipt. One rule now says this everywhere agents read it (the fleet and CLI instructions, the cross-instance-messaging and worker-collaboration skills), and running agents are told once.
  - A guest (`via web (guest)`) still only chats, and a reviewer's APPROVE is still not a human go-ahead.
