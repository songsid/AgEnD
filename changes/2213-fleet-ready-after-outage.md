---
section: Fixed
---
- **"Fleet ready" reaches the chat even when the network was down while the fleet started (#2213).** After an update or restart during an outage, the completion message got one 30-second try and was then dropped, so the chat could still say the fleet was stopped while it was running. It's now retried once the connection is back, for up to 30 minutes: AgEnD edits the update's own message when there is one, and posts a new one otherwise. A send that timed out on AgEnD's side may still have landed, so it never posts a second copy until that send has an outcome. 2.2.1 has the same gap.
