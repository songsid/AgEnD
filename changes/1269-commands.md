---
section: Added
---
- **Web chat: commands and quick actions (#1269).** Typing `/` in an instance's chat opens its own chat commands, the same ones its Telegram/Discord topic accepts. They run through the same handlers and command table (#754/#1148).
  - The commands: `/ctx`, `/compact`, `/clear` (asks first), `/model`, `/effort` (with nothing after them, a list to choose from), `/cancel`, `/btw`, `/steer`, `/pause`, `/wake` and `/save`.
  - Anything else starting with `/` is still sent as a message. Fleet-wide commands stay in General.
  - Quick actions: the model and effort in the chat's header open their lists. **Compact** and **Clear…** appear once the instance's context is 70% used.
  - Over the temporary public link, a message starting with `/raw ` is refused: it would reach the CLI without the `[user:]` envelope. `/save` is refused there too.
