---
section: Changed
---
- **A kiro instance no longer posts "the resumed conversation did not switch to this instance's agent" to its topic (#1794).**
  - When a resumed kiro conversation cannot be switched to the instance's own agent within 15 s, it keeps running as before and the next launch tries again. Nothing is lost and there is nothing to do, so the message now goes only to the log and the instance's **Log** tab.
  - The same applies to "the instance now runs as its own agent, but AgEnD could not record that".
  - "AgEnD could not read or update the shared .kiro …" is still posted. That file belongs to your project and needs fixing by hand.
