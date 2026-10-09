---
section: Fixed
---
- **Settings: each connection shows its own state (#1537).** Every connection used to say "Connected" whenever AgEnD was running, even one that had not started or whose token was refused. Now each row shows that connection's own state: Connected · @your_bot, Reconnecting, Starting, Not running, Token missing, Token rejected, or the Message Content Intent fix.
