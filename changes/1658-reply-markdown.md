---
section: Changed
---
- **Agents: `format: markdown` on Telegram now means markdown; raw HTML tags are shown as text (#1658).** A `reply` with `format: "markdown"` was sent to Telegram as HTML without conversion, so text containing `<` or `&` (`a<b`, `x && y`) was refused and the reply failed, and `**bold**` showed literally. It is now converted from markdown with everything escaped first: `<`, `&` and `>` are shown as typed, and **bold**, *italic*, ~~strike~~, `code` and http(s) links are rendered. HTML tags were never documented under "markdown" and now appear as text. If Telegram still refuses the markup, the reply is sent once more as plain text. Replies with tables, code blocks or headings still go out as Telegram rich messages, unchanged.
