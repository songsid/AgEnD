---
section: Fixed
---
- **ClassicBot (Discord): replying to a message with only @bot now asks about that message (#3340).** A reply whose text was only the bot's mention was silently ignored. It now reaches the agent with the replied-to message as context, as it already did on Telegram. A bare @bot that is not a reply is unchanged.
