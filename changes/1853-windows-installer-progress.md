---
section: Changed
---
- **The Windows installer no longer sits silent.** Every long step (enabling and updating WSL, installing Ubuntu, packages, each AI backend, AgEnD) shows how long it has been running and how long it usually takes, with the tool's own progress under it. WSL updates fall back to downloading from GitHub when the Microsoft Store is blocked. While such a step runs, clicking in the window no longer freezes it (QuickEdit is off), and Ctrl+C asks whether to stop instead of stopping halfway; both are put back afterwards. A short notice at the start explains how to copy and paste in that window, and not to press Ctrl+C.
