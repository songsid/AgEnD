---
section: Fixed
---
- **Windows pane hosts stop when their runtime is switched off (#2965).** After owned panes have positively ended, the empty host exits and starts again when needed. Reconnects preserve live panes without startup keys or replay; exact exit and no-launch receipts settle retained reservations without treating uncertain outcomes as stopped.
