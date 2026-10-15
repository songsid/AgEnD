---
section: Added
---
- **Agents can see how they appear on the web (#1629).** `get_web_appearance` returns an agent's face and where it comes from, its ring colour, its identity card field by field, its theme per light/dark mode, its lock and its limits — resolved exactly as the dashboard resolves them. `preview_web_appearance` draws that as an SVG per mode into `.agend/appearance/` in the agent's working directory, with the pictures it shows written beside it (only its own). Also `agend-agent appearance [preview [light|dark]]`.
