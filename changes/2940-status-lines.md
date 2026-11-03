---
section: Fixed
---
- **ClassicBot: other bots' "處理中…" status messages no longer fill every bot's chat log (#2940).** In a room with several bots, each bot's transient status message ("👀 處理中…" and its emoji variants, deleted once the reply lands) used to land in every other bot's `[Chat log for context]` and in `chat-logs/YYYY-MM-DD.log`. Measured: about 1 line in 10 in a busy channel.
  - AgEnD now recognises its own status messages, from any bot of the fleet, by the message id it recorded when posting them, never by their text, so a person who writes 「處理中」 is still logged. Those messages are never logged.
  - A status message logged before its id was known is taken out again.
  - On Discord, a deleted message is removed from the chat logs, and one deleted before it arrives is never logged.
  - Real replies and people's messages are unchanged.
