# ClassicBot reply routing

How an agent's `reply` (and `react` / `edit_message`) finds its way back to a
ClassicBot channel, and why the fleet manager rewrites the address the daemon
supplies.

## The path

1. **Inbound.** `forwardToClassicInstance` (`src/fleet-manager.ts`) delivers the
   user's message with `meta.chat_id` and `meta.thread_id`. For a Telegram forum
   group registered as a ClassicBot (#1085), the channel is keyed by its chat
   id, so the inbound handler sets `threadId` to the chat id and carries the
   real forum topic as `transportThreadId`; `forwardToClassicInstance` puts that
   topic in `thread_id`.
2. **Daemon.** The agent's tools do not take `chat_id` / `thread_id`. The daemon
   fills them from its last inbound context (`lastChatId`, `lastThreadId`,
   persisted to `last-chat.json` with the adapter id) before forwarding the call
   to the fleet manager (`src/daemon.ts`, the reply/react/edit_message branch of
   the tool handler).
3. **Fleet manager.** `handleOutboundFromInstance` (`src/fleet-manager.ts`) picks
   the adapter from the daemon's adapter id, then, for a ClassicBot instance,
   overrides the address:
   - `chat_id` is always forced to the instance's registered ClassicBot channel
     id. The daemon's value cannot be trusted here; on Discord it may be the
     guild id.
   - `thread_id` is kept only on Telegram when it names a topic different from
     the channel id (a forum ClassicBot replying in the topic it was asked in).
     Otherwise it is deleted: on threadless Telegram it just echoes the chat id
     and would fail with "thread not found", and on Discord the channel id is
     already the address.

## Platform result

| Platform | `chat_id` sent | thread |
|---|---|---|
| Telegram, private chat or plain group | ClassicBot chat id | none |
| Telegram, forum group | ClassicBot chat id | the topic the message came from (`message_thread_id`) |
| Discord | ClassicBot channel id | none; the adapter sends to `threadId ?? chatId` |

## Lessons still worth keeping

- `handleOutboundFromInstance` is shared by every adapter. A fix for one
  platform's ClassicBot routing changes the other's: test both.
- Never rely on the daemon's `chat_id` for a ClassicBot reply. The registry
  (`classicChannels.getChannelIdByInstance`) is the source of truth.
- Reactions follow the same rule as replies. In `handleClassicChannelMessage`
  the react target is `msg.threadId ?? msg.chatId`, which is the ClassicBot key
  (the Telegram chat id, or the Discord channel id), never a Telegram topic id:
  Telegram reactions are addressed by chat, not by topic.
- In a multi-adapter fleet the reply goes out through the adapter recorded with
  the last inbound message. A message id from one bot's world sent through
  another adapter fails with a 404.
