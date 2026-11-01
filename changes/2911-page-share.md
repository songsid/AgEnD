---
section: Added
---
- Web chat, HTML preview panel: **Share page**. A fleet admin makes a link anyone can open to see one agent page, for 15 minutes to 24 hours (1 hour by default), with no sign-in. A confirm dialog comes first every time, saying which page, that it runs the page's own scripts in the viewer's browser, and for how long. The link is shown once, to copy.
- The page is a snapshot of what the agent sent. It runs sandboxed, apart from the dashboard, and the viewer sees the page only: not the chat, the agent or the fleet.
- While a page is shared, the panel says **Shared until …** with **Stop sharing**, and Settings → Access & security lists the shared pages with Stop. The chat it came from is told when a share starts and ends; the link itself is never posted.
- The link runs on the Office share links' own quick tunnel, never the `/web` link or its hostname. `web.page_share: { enabled, max_hours }` turns it off or shortens it.
