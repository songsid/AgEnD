---
section: Fixed
---
- **codex: a resumed idle session no longer reads "working" for the whole hang window.** Sometimes a resumed codex draws its footer without the Context item. If its own rollout shows no open turn and its empty composer stays unchanged, the next safety sweep now marks it idle within about a minute; before, it waited for the 15-minute stuck deadline, and deliveries queued meanwhile. (#1865)
