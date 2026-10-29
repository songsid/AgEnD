---
section: Added
---
- **Guests can run the chat's "anyone" commands and open the usage panel (#2855).** On the web dashboard a guest's command palette now offers exactly the commands the chat's own command table lets anyone run in that agent's channel: `/ctx`, `/steer`, `/btw` and `/cancel`, only for agents the guest can see, and only while guests may chat. Any other command is refused with why. A guest's `/steer` or `/btw` reaches the agent as a guest's (`via web (guest)`). At most 10 commands a minute per guest, one at a time. Guests also get the usage panel (◔), every subscription's headroom on the host, the same as `/usage` shows anyone in chat; they never force a refresh, and the per-agent cost report stays admin-only.
