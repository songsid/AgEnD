---
section: Fixed
---
- **Agents: a Telegram `edit_message` with `format: "markdown"` no longer fails on `<` or `&` (#1651).** Since #1654 such an edit was sent as Telegram HTML as-is, so text like `a<b` or `x & y` was refused ("can't parse entities") where it used to go through as plain text. The edit text is now converted from markdown with everything escaped first: `<`, `&` and `>` are shown as typed, and **bold**, *italic*, ~~strike~~, `code` and http(s) links are rendered. If Telegram still refuses the markup, the edit is retried once as plain text. Tables and code blocks don't re-render on edit.
