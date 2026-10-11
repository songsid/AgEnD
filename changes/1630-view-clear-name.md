---
section: Fixed
---
- **View: clearing a display name brings back the agent's own (#1630).** Clearing the display name in View's **Edit profile** used to store an empty name, which still hid the name the agent had given itself (`set_display_name`), so the instance name showed instead. Clearing now removes the override, and the agent's own name (or the instance name) shows again. Display names cleared before this release recover too.
