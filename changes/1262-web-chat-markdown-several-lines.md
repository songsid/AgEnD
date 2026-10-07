---
section: Added
---
- **Web chat: Markdown, several lines, and history that survives a reload.** Messages in the dashboard's chat now render
  Markdown — bold, italics, `code`, code blocks, lists, quotes, links (http/https/mailto only, opened in a new tab) — and
  nothing in a message can add markup of its own (the text is escaped before any formatting is applied). The composer takes
  several lines (Enter sends, Shift+Enter adds a line) and gives the text back if sending fails. A reload no longer empties the
  chat: the fleet keeps each instance's recent messages (`GET /ui/history`, in memory, bounded), and a stream that drops and
  reconnects is sent what it missed. Long agent replies are no longer cut at 2,000 characters in the web chat (16,000 now).
