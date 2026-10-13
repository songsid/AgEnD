---
section: Fixed
---
- **An agent resumed across an upgrade can pass `forwards` again (#1780).**
  - A Claude Code session resumed across the beta.7 upgrade still saw the old `send_to_instance`, without `forwards`. It put the verification ID in the message text instead, which grants nothing, so the receiver's `delivery_status` said "Delivery not found".
  - Claude Code keeps a tool's schema from when the session first loaded it, and reloading it does not refresh it. AgEnD's server still accepts the new parameter.
  - Running instances are now told once (the what's-new notice) that `send_to_instance` and `delegate_task` take `forwards`, and that an ID in the text grants nothing. The notice no longer suggests reloading the tool; it says to use the new parameters anyway.
  - The forwarding guidance (skills, tool description and docs) names this failure.
