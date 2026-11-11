---
section: Added
---
- **A reasoning-effort dropdown in Settings → agent → Runtime & model (#3659).** It sits under the model field: its choices are the levels the selected model takes (the same list as the chat chip's `/effort`), so changing the model changes them; the first choice, "Model default", is the unset state and is never written. A choice goes through the chip's own `/effort`, so it is the same value as the chip and a running agent applies it at once (some CLIs, such as Codex, restart the agent for it to take effect). Nothing shows for a Windows agent, Antigravity, or a CLI or model without an effort setting. While the model field holds an unsaved change the field waits for Save. Going back to "Model default" is not offered, as in the chip.
