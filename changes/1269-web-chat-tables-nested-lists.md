---
section: Added
---
- **Web chat: tables, nested lists and highlighted code (#1269).** Agent replies with a Markdown table now show as a
  table (header, `:--`/`--:`/`:-:` alignment, cells with their own bold/links/`code`; a pipe inside a cell is `\|`), lists
  nest by indentation (bullets and numbers mixed, up to six levels), and fenced code in js/ts/json/python/sh is
  highlighted. No library and nothing from a CDN: the same escape-first renderer, with only fixed tags and classes
  added, so nothing in a message can still produce markup of its own.
