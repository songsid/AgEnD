---
section: Added
---
- Office **Drag and pat** now supports dragging an Agent onto another valid seat in its current area to seat it there immediately (persisting per device, office, and style; swapping cleanly when occupied; respecting reserved seats and **Idle people stay in their own area**) (#4266), and introduces a "being dragged" state (`dragged` pose) while carried — playing an optional skin-pack `characters.<set>.dragged` / `default.dragged` strip (supporting multi-frame, multi-sheet, and frame-list strips) or a built-in lifted, dangling animation otherwise, returning to its prior pose on release, and respecting reduced motion (#4267).
