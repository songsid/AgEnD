---
section: Fixed
---
- **After updating to beta.11 or later, agents are told about polls and web identity (#1823, #1827).**
  - The what's-new notice is sent only when there is a new entry for agents, and none had been added since beta.7. So after `/update` to beta.10 or beta.11 a running agent heard nothing. It could keep naming an older AgEnD version, and a resumed session did not know about `reply`'s `poll` or `close_poll`.
  - Running instances are now told once: `reply` takes `poll` (its exact parameters), the results come as one `[poll results]` message, and `close_poll` ends a poll early. They are also told that a web-chat person now carries their Discord or Telegram user id, for recognition only.
