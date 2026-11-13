---
section: Fixed
---
- **Codex 0.169.0: a conversation that is still loading after a resume is recognised again (#3833).** In codex 0.169.0, the loading screen has an extra hint row, so AgEnD stopped recognising it as still loading. It was already safe, because that screen was also never treated as ready. AgEnD recognises it again, so nothing can be typed into a conversation that is still loading.
