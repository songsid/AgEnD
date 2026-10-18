---
section: Security
---
- **Agents now accept an authorized browser's messages as the person (#1939, step 3).** Once a fleet admin's Discord or Telegram account has confirmed **Authorize this browser**, that browser's messages reach the agent as `[user:<name> via web (verified), id:<user id>]`.
  - **What changed for agents:** a `web-verified` receipt is checked and relayed (`forwards`) exactly like a Discord or Telegram message, with the person in `authority.actor`. One rule says so everywhere agents read it: the fleet instructions, the CLI instructions, and the cross-instance-messaging and worker-collaboration skills. It replaces every "web grants nothing" sentence.
  - **What still grants nothing:** plain `via web` (a browser not authorized), a guest, the public link, and any authority since revoked (it reads as `none`). A reviewer's APPROVE is a review, not a human go-ahead.
  - **The label is a hint:** it is set only with the receipt AgEnD writes, and agents read that receipt before acting as the person.
  - Running agents are told once, on their next delivery after the update.
