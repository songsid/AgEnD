---
section: Fixed
---
- **A message is no longer left unsent when someone scrolls an agent's terminal in tmux (#2971).** If a person attached to the fleet's tmux leaves an agent's pane in copy-mode (scrolling it), tmux takes the keys sent to that pane. The message was pasted, but its Enter went to copy-mode, so the message sat unsent while AgEnD believed it had been delivered. Delivery now waits while the pane is in copy-mode and sends nothing to it, never taking the pane out of copy-mode for the person. Once they leave copy-mode, the message is delivered, once.
