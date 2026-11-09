---
section: Fixed
---
- **A Restart button, or a choice in a `/model` or `/effort` menu, now acts only on the agent it was offered for.** Pressed for an agent that was then stopped, restarted, or deleted and recreated under the same name — even in the moment while the button was being taken away — it used to restart (or change the model of) whichever agent had that name by then. Nothing is changed now: the message says the agent was stopped, restarted or replaced, and a menu asks to be opened again. (#1490)
