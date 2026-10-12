---
section: Fixed
---
- **Web: spell checking is off where it should be (#1700 follow-up).** The sidebar filter, the bot-token field, the fleet.yaml editor and the delete-confirmation box were meant to have spell checking off, but they rendered with it on. In Chrome with enhanced spell check, the text of a bot token shown in the token field could be sent to Google's spelling service. Spell checking is now really off in all four.
