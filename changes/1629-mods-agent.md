---
section: Added
---
- **Agents and mods (#1629).** `export_web_mod` writes an agent's own web look to a mod file in its working directory: its theme and pictures, its card text and its widgets, never custom CSS. `propose_web_mod` sends a mod file for a person to review: it appears under **Settings → Appearance → Mods → Proposed by agents**, where **Review** opens the usual two-step import and **Dismiss** drops it. A proposed mod carrying custom CSS is refused, and agents never import. Also `agend-agent mod export|propose`.
