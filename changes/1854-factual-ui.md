---
section: Fixed
---
- **Web: Settings and Needs you say what is true (#1854).**
  - When no stuck timeout is set, Settings and the hang notice now show 10 minutes, the detector's real default, instead of 15.
  - Settings help puts the dashboard's own settings under **Web**, not General.
  - The access hint points to **Connections**.
  - A change that waits for a fleet admin says it is confirmed in chat (the General topic) or on the host.
  - The public-link hint no longer claims "No preview exposure": previews get their own temporary tunnel unless `web.preview_on_public_link` is false.
  - An empty Needs you no longer promises Discord. A fleet with no chat app is told only that items show there.
