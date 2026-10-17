---
section: Added
---
- **Widgets on the web dashboard (#1629).** A widget is a small panel the dashboard draws with its own components: numbers, a progress bar, a line of text, a short list, a coloured badge or a sparkline. It is built from a short JSON spec and values; no HTML, script, links or CSS come from whoever wrote it, and every widget carries a ✦ chip.
  - **Agents** place one under their own chat header and one on their own Details page with `set_web_widget`, and update its values as they work (at most every 10 s, separate from theme changes). They remove it with `remove_web_widget`, or `agend-agent widget` from a shell. A widget can also show the agent's own state, context and cost.
  - **People** remove an agent's widget from the chat's or Details' ⋯ menu, and **Lock theme** stops changes. **Settings → Web appearance → Your sidebar widget** puts your own widget under the instance list, with the fleet's counts, on all your devices.
  - **Show agents' themes, effects and widgets** off, or `?safe=1`, hides agents' widgets.
