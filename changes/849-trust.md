---
section: Fixed
---
- Kiro's native TUI trust-all-tools prompt now uses the same structural selector at startup and runtime (#849, part A). AgEnD sends one Down from “No, exit”, then confirms only a freshly observed cursor on the per-session “Yes, I accept”. Unknown layouts, a cursor that did not move, and “Yes, and don't ask again” stay held for human input; copied history cannot receive consent keys. Existing model-picker holds and engine/session pins remain intact. This does not enable `kiro_ui: v3`; v3 startup/enablement and further steering verification are parked pending native evidence and user demand.

- Each consent phase is claimed once per launch across startup/runtime, including uncertain key ACKs; stop and tmux replacement retire stale runtime keys. Native column-zero TUI composers disqualify copied trust frames.
