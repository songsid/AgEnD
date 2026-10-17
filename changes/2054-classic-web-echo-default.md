---
section: Changed
---
- **ClassicBot rooms echo web chat by default (#2054).** A message sent from the web chat to a ClassicBot instance is now copied into its rooms (`🌐 web · <name>: …`), group channels included, the same way fleet topics already were. A room without a `web_echo` setting follows the fleet-wide `web.echo_to_channel`, so a fleet that turned web echo off stays off. `web_echo: false` in `classicBot.yaml` (or unticking Web echo in the room's Settings) keeps one room off, and that choice is saved explicitly. **After upgrading, existing rooms that never set `web_echo` start echoing**; set `web_echo: false` on any room that should stay quiet. The confirmation shown when enabling echo for a group channel is gone.
