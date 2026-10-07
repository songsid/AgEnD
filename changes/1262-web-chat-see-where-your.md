---
section: Added
---
- **Web chat: see where your message got, see that the agent is working, and stop it.** Each message you send
  from the web chat gets ticks, the same lifecycle a Telegram message shows as reactions: ◷ waiting behind another
  message, ✓ handed to the agent, ✓✓ the agent has it, ! not delivered (each labelled for screen readers, and
  kept across a reload). While the open chat's agent is working, a "*name* is working…" line shows above the
  composer with a **Stop** button that does what Telegram's cancel button and `/cancel` do: Esc into the CLI, and
  the messages still waiting are dropped — their ticks turn to ⊘. (Stop is `POST /ui/cancel/<instance>`, behind
  the same session and CSRF check as every other dashboard write; it is not the instance's Stop, which ends its
  process.) Delivery reports for web messages no longer try to react on Telegram with an id that was never a
  Telegram message.
