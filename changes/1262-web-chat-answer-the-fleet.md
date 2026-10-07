---
section: Added
---
- **Web chat: answer the fleet's prompts from the dashboard.** When an instance looks hung, exits on its own, or is
  stuck on an interactive prompt, the buttons Telegram shows (*Force restart* / *Keep waiting*, *Restart* / *Ignore*,
  *Confirm* / *Cancel*) also appear in that instance's web chat. They are the same prompt, not a copy: one answer counts,
  whichever surface gives it first; the other's buttons collapse to the outcome; and the prompt expires on both at
  once. Only these instance-health prompts are offered there — a `/clear` confirmation, login, Classic group
  approval, tips and the `/model` / `/effort` menus stay where they were asked. A dashboard answer needs the
  signed-in session and its CSRF token, names the instance, and must be one of that prompt's own buttons.
