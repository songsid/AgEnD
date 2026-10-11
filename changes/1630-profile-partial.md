---
section: Fixed
---
- **View: saving one profile field no longer clears the others (#1630).** A profile save now changes only the fields it carries (display name, role, description). A field left out stays as it was, and a blank one clears it. View's own editor always sends all three, so nothing changed there; any other caller that sends one field no longer wipes the rest.
