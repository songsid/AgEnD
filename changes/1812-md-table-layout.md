---
section: Fixed
---
- **Web chat: Markdown tables no longer sit against the scrollbar or break words in the middle (#1812).**
  - In a `.md` attachment's preview, the table now has the same space on both sides, and the scrollbar no longer touches it.
  - Table cells keep words whole: "director" is no longer split into "directo" / "r". A table too wide for the message scrolls sideways in its own frame, instead of squeezing its columns.
  - A long file path in a table cell wraps after its `/`, not in the middle of a name.
  - This applies to tables in chat messages, `.md` previews and CSV previews alike.
