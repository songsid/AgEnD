---
section: Changed
---
- **HTML previews in the web chat take files up to 8 MB, and larger ones on request (#2863).** A ```html block or an attached .html file up to 8 MB previews as before; this used to stop at 1 MiB. Above 8 MB the card asks "This file is large (12 MB). Preview anyway?" and runs it only on that click, in the same sandboxed frame (or in the side panel, if that is where it was opened). A large file isn't downloaded until then. Past 50 MB there is no preview, only the download. The text Show card for Markdown, CSV, code and other text stays at 1 MB, because it formats the file in the page itself. The sandbox, its CSP, the watchdog and the growth freeze are unchanged.
