---
section: Added
---
- **An agent can react to a web chat message (#2305): the minimal reply the platforms already had.** A message that only needs an acknowledgement ("OK", "thanks") may be answered with an emoji under the person's bubble instead of a reply.
  - **Live and kept:** the reaction appears at once and is kept with the chat history, so it survives a reload, another device and a restart. A guest sees it on the messages it may see.
  - **The channel copy:** when the web message was copied to the agent's Discord/Telegram topic or ClassicBot room, the copy gets the same reaction.
  - **It counts as the answer:** a reaction completes the turn as on Discord and Telegram, so the chat no longer says the agent ended its turn without replying, and AgEnD no longer asks for a conclusion.
  - **Emojis:** Telegram's fixed reaction set (one set on every platform), never AgEnD's delivery marks. Another emoji is refused with an error naming allowed ones.
  - **Instructions:** the agent's instructions and the `react` tool say when a reaction is enough.
