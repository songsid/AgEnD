---
section: Changed
---
- **The Canvas Worker effect code is gone (#2799).** After #2793 nothing could turn it on; now the code itself is removed, along with the once-a-second `fleet.yaml` check that watched its switch. Nothing changes on the page or for agents: a saved `web.experimental.canvas_worker` still loads and stays in `fleet.yaml`, a call to a removed tool gets the same answer, and saved effects, placements and mods stay on disk untouched, so a downgrade finds them.
