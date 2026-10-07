# Channel and delivery pitfalls

Things that have bitten people changing the channel adapters or the delivery
path. Read before touching `src/fleet-manager.ts` inbound/outbound code,
`src/daemon.ts` delivery, or an adapter under `src/channel/adapters/`.

## How a message reaches a CLI today

- **One facade.** Every agent-directed message from the fleet manager goes
  through `FleetManager.deliverToInstance()` (`src/fleet-manager.ts`): General
  topic, fleet topics, ClassicBot channels, schedules and cross-instance
  messages (the outbound handlers call it via `deliverToInstance` in
  `src/outbound-handlers.ts`). It wakes a paused target and, for
  cross-instance and schedule work, serialises delivery behind the target
  being idle. Put a cross-cutting feature (cancel button, wake, attachment
  meta) here, not in one entry path.
- **Not everything uses it.** `/save` and `/load` paste a raw command over IPC
  (`raw_paste`, `pasteRawToClassicInstance`) without going through the facade.
- **Durable cross-instance outbox.** `send_to_instance`, `delegate_task`,
  `report_result`, `request_information` and `broadcast` are admitted to a
  SQLite outbox (`delivery-outbox.db` in the data dir,
  [`src/delivery-outbox.ts`](../../src/delivery-outbox.ts)) before the tool
  answers; silent schedules are admitted as `raw_paste` rows. The tool returns
  `queued` with a `delivery_id` and `operation_id`; `delivery_status` reads the
  row. A row in `uncertain` may have been delivered, so it is never replayed
  blindly. `failed` and `uncertain` rows are reported to the fleet. Design:
  [929 durable outbox](929-durable-outbox.md),
  [926 reply obligations](926-reply-obligations.zh-TW.md),
  [856 verifiable inbound](856-verifiable-inbound.zh-TW.md).
- **Who drains it** is `delivery_worker` (`off` | `wake_only` | `on`, default
  `wake_only`; `resolveDeliveryWorkerMode` in `src/types.ts`). `wake_only` wakes
  a paused target that has queued work; `on` also gives the target a
  per-instance worker (`src/target-queue-worker.ts`). See
  [configuration.md](../configuration.md).
- **Inside the daemon**, `deliverMessage()` (`src/daemon.ts`) returns
  `Promise<boolean>` and drives the status reactions: ⏳ `message_queued`,
  👀 `message_delivered`, ✅ `message_confirmed`, ❌ `message_failed`. It
  returns `false` only on a real failure; callers must check it before
  clearing state or reacting.

## Fixed, kept for history

- *Two slash-command handlers that had to be edited in step* (primary and
  secondary adapter). Fixed: every Discord adapter calls one
  `dispatchSlash()`, gated by the command table; see
  [command-permissions.md](command-permissions.md).
- *Five delivery exits with no common entry.* Fixed by the
  `deliverToInstance()` facade above.
- *`deliverMessage` returned `void` and always emitted `message_delivered`,
  even after a failed paste.* Fixed: it returns a boolean and emits
  `message_failed`.
- *ClassicBot collab images saved without an @mention never reached the
  agent.* Fixed: `forwardToClassicInstance` takes the last `[📷 saved: …]`
  path from the chat-log context as `meta.image_path` when the triggering
  message has no image of its own.

## Still true

**Reactions are addressed differently per platform.** Telegram reacts on the
chat (`setMessageReaction(chatId, …)`); the adapter ignores the thread
argument. Discord reacts on `threadId ?? chatId`, because a thread is its own
channel. Pass the real chat id to Telegram, never a forum topic id.

**Where `/ctx` gets context %.** `resolveInstanceContext`
(`src/topic-commands.ts`): claude-code reads `statusline.json` in the instance
dir. Everything else (and claude-code without the file) is a pane scrape parsed
by `parseContextPercent` in [`src/context-percent.ts`](../../src/context-percent.ts),
which scans lines bottom-up for several backend formats. Background reads are
cached; `/ctx` bypasses the cache.

**The interrupt key is per backend.** Use `backend.getCancelKey()`; never hard-code
Escape. kiro-cli and grok use `C-c`; the others use `Escape`.

**A null pane status is not a crash.** `getPaneStatus()` returns `null` when the
tmux query fails, which happens transiently when tmux is busy (for example
during a fleet restart). The health check re-queries once after 1.5 s before
treating it as a dead window (`src/daemon.ts`); a non-null `{alive: false}` is a
real exit and needs no recheck. Skipping the recheck brings back restart storms.

**kiro-cli is launched without `--require-mcp-startup`** (#1111,
`src/backend/kiro.ts`). The flag exits when any enabled MCP server fails,
including the user's own, so one broken third-party server took down every
kiro instance. Whether AgEnD's own MCP server connected is checked by the
daemon instead.

**Discord is built in.** `src/channel/factory.ts` constructs `DiscordAdapter`
from `src/channel/adapters/discord.ts` directly; the plugin loader is only the
fallback for other adapter types.
