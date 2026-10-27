---
section: Changed
---
- **Canvas Worker effects are removed (#2793).** The experimental switch is gone from Settings → Web dashboard, and nothing turns the feature on. Agents are no longer offered the effect tools or `export_web_mod` / `propose_web_mod`, and the effect pages and routes are refused. A saved `web.experimental.canvas_worker` still loads, is ignored and is left in `fleet.yaml`. Saved effects, placements and mods stay on disk untouched, so a downgrade finds them. Ambient effects (falling petals, click stars, `set_web_ambient`), themes, widgets and custom CSS work as before.
