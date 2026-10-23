---
section: Changed
---
- **Search over the temporary public link, and on a phone (#2478).** Global search (Ctrl+K) now works for fleet admins over the temporary public link too, so a phone signed in through `/web` has the **Search** row in its menu and the 🔍 button. Guests still never get it. `web.search.public_link: false` keeps it off the public link only, and `web.search.enabled: false` still turns it off everywhere. On a touch screen the row no longer shows the Ctrl K hint.
