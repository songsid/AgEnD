---
section: Fixed
---
- **Web: a preview port that can't be opened says so (#2061 follow-up).** When the HTML preview listener could not open its port (another program holds it, or the port is invalid), a card said "Previews are turned off for this fleet (web.preview: false)", sending people after a setting nobody had changed. It now says the fleet could not open its preview port, with the port and the error (for example `19281: EADDRINUSE`), and what to do. The public-link messages for a rate-limited or refused temporary link no longer claim "the LAN link still works" — the dashboard listens on this machine only; they say the dashboard on this machine still works. The credential-profiles skill describes the usage card as it looks since #2014.
