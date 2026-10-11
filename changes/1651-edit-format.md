---
section: Fixed
---
- **Agents: `edit_message` keeps a message's formatting (#1651).** `edit_message` took a `format` but ignored it, so on Telegram an edit to a message that was sent with `format: "markdown"` came back as plain text. An edit now renders like `reply`: `format: "markdown"` is rendered on Telegram, and Discord, which always renders Markdown, is unchanged.
