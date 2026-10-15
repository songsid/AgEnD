---
section: Added
---
- **Web: agents' themes (#1629).** An agent can give its own web chat a look with the `set_web_theme` tools: colours for light and dark, accent, bubbles, font, a background picture, its own picture and its working label.
  - A theme changes only that agent's chat and its picture and ring in the sidebar. Values are checked on the host and again on the page, and pictures are served by the dashboard itself with their metadata removed.
  - In a chat's or Details' **⋯** menu, a signed-in admin can **Lock** or **Reset** an agent's theme; neither is offered over a temporary public link.
  - **Settings → Appearance → Show agents' themes and effects** turns them off on all your devices. `web.themes.agent_edit: false` refuses every agent's changes.
