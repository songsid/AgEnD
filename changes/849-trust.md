---
section: Fixed
---
- Kiro's native TUI trust-all-tools prompt now uses the same structural selector at startup and runtime (#849, part A). AgEnD sends one Down from “No, exit”, then confirms only a freshly observed cursor on the per-session “Yes, I accept”. Unknown layouts, a cursor that did not move, and “Yes, and don't ask again” stay held for human input; copied history cannot receive consent keys. Existing model-picker holds and engine/session pins remain intact. This does not enable `kiro_ui: v3`; v3 startup/enablement and further steering verification are parked pending native evidence and user demand.
