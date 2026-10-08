# #1386 — "Needs you": one list of everything waiting on the user (design)

Status: design for review, revised for the user's scope (2026-10-08). Milestone 2.2.0. Reference: todos.dev's inbox
(https://todos.dev/docs/inbox) and fable's report "todos dev vs AgEnD" (§4, §5.1).

## 1. Goal and non-goals

**Goal.** Discord is where people act, and the web shows the same list. There is one list of everything currently
waiting on the person, across every instance, **derived from existing state** (§3).

- **Discord (and Telegram): the primary surface.** Each world's General (each Discord or Telegram bot) has one live **Needs you** message
  that is kept up to date. Every item in it is one tap from where it is acted on: the prompt's own message with its
  existing buttons, or the instance's thread. The only new button is **Acknowledge** for delivery items, which
  have no button today (§5). Optionally, fleet admins also get a DM when a new item appears.
- **Web: the same list, presented.** `/ui` gets a Needs you view and a sidebar badge, with one tap to the
  instance's chat. A device can opt in to browser notifications (§6).
- **Resolved anywhere, gone everywhere.** All surfaces are renderings of one derivation (§4). An answer on
  Discord, Telegram or the web changes the underlying state, and every surface re-renders from it.
- **Who sees what (decided 2026-10-08):** chat is scoped to the **owning world**, and `/ui` is global (§5.0).

**Non-goals (v1).**
- **No new source of truth for items.** The server keeps two small records, and neither decides what is listed:
  - where each world's live message is (§5.4);
  - which delivery items were acknowledged: two columns on the existing outbox row (§3.4).
- No answering a prompt from the General message itself. Its buttons are bound to its own message (§5.2). The General
  message links to it instead.
- No org chart here (#1389, after this), and no diff review (#1388).
- No server-side Web Push in v1 (§6.3).
- No "agent asked the user a question" item (§3.6).

## 2. The flow, end to end

1. **Something starts waiting.** For example, beta's Claude Code holds a Bash permission dialog. The daemon's
   interaction observation reaches `waiting`, and `instance_interaction` fires (§3.2).
2. **The fleet recomputes** `getNeedsYou()`. A new id appears (§4.2).
3. **Discord**: the General **Needs you** message is replaced by a new one at the bottom, which notifies people
   (§5.3). Its line "beta — Permission needed · <#beta>" opens beta's thread in one tap. With `needs_you.dm`, admins
   also get a DM (§5.5).
4. **The web**: connected pages get SSE `needs`, the badge goes to 1, and a hidden tab that opted in shows a
   notification (§6).
5. **The person answers**, wherever it applies: at the terminal through the thread or `/ui`, a prompt button in
   Discord, Telegram or the web, or Acknowledge for a delivery item. The underlying state clears, the fleet
   recomputes, and the General message is edited, the web list updates, and the badge drops, together.

## 3. Item sources (all existing state)

Line numbers are at main `ea15ae2e`.

### 3.1 `prompt`: a fleet prompt that waits for an answer

- **State:** `FleetManager.pendingNonceButtons: Map<nonce, NonceButtonEntry>` (`fleet-manager.ts:957`), filtered
  by `WEB_MIRRORED_PROMPT_PREFIXES` = `hang:`, `exit-restart:`, `interactive-assist:` (`:647`).
- **Existing projection:** `listWebPrompts()` (`:10158`) gives `{instance, nonce, text, actions[{id,label}],
  expiresAt}`. The web chat already shows exactly these (C4).
- **Appears:** when `postNonceButtonPromptOrThrow` (`:9895`) runs. It already emits SSE `prompt` (`:9960-9966`).
  The callers:
  - hang: `sendHangNotification` (`:12403`);
  - normal exit: `notifyNormalExit` (`:10658`);
  - interactive prompt: `notifyInteractivePrompt` (`:10773`).
- **Resolved anywhere:**
  - a click on Telegram, Discord or the web goes through `consumeNonceCallback` (`:10013`), which deletes the entry
    (`:10071`). The web click comes through `POST /ui/prompt` (`web-api.ts:460`) → `clickWebPrompt` (`:10174`);
  - expiry, after 15 minutes (`:9925-9935`);
  - the instance stopping (`clearNoncePromptsForInstance`, `:10641`);
  - shutdown (`retireNonceButtons`, `:10207`).

  Every one of these already calls `webPromptGone` (`:10153`), which emits `prompt_resolved`.
- **Item:** `id = "prompt:<nonce>"`. The title comes from the prompt kind: "Not responding", "Exited", or "Waiting
  at its terminal". The detail is the prompt's own text, trimmed to one line. The actions are the prompt's own,
  answered through the existing `POST /ui/prompt`. `since` is the entry's creation time (new field: `createdAt`,
  set where the entry is made).
- **Known limit (existing behaviour, unchanged):** an interactive-assist or hang prompt is not retired when the
  terminal clears by itself. It stays until it is clicked or expires. This is the same as on Telegram. The inbox
  shows the same prompt the chat shows; it does not hide it.

### 3.2 `awaiting_input`: the CLI is waiting at its terminal

This also covers dangerous-command and permission dialogs.

- **State:** `Daemon.interactionObservation` (`daemon.ts:1363`; `interaction-observation.ts:22`).
  - `presentationState()` (`interaction-observation.ts:114`) is `awaiting_input` only when `phase === "waiting"`,
    not stale and not suspected, and the instance is not paused.
  - `kind` is one of `permission | dangerous_command | login | dialog | suspected_terminal_input`
    (`backend/types.ts:11`).
  - A dialog the backend only holds (a Claude Bash permission, an unknown-cursor dangerous command, Codex
    approvals; `claude-code.ts:1068`, `codex.ts:1942…2073`) stays `waiting`. A dialog AgEnD answers by itself
    clears within a capture or two, and the 500 ms confirmation (`interaction-observation.ts:92-96`) keeps it out.
- **Existing projection:** `FleetManager.instancePresentation()` (`fleet-manager.ts:2417`) → `getUiStatusSync()`
  (`:16993`) gives `state`, `interaction` (`{phase, kind, since, …}`) and `interaction_summary` (a localized
  category plus the age; pane text is never exposed).
- **Item:** while an instance's `state === "awaiting_input"`, `id = "awaiting:<instance>:<interaction.episode>"`.
  The title is by kind: "Permission needed", "Dangerous command waiting", "Sign-in needed", or "Waiting at a
  dialog". The detail is `interaction_summary`, and `since` is `interaction.since`. The only action is **Open**:
  the answer is given at the terminal, or through a `prompt` item when one exists.
- **De-duplication, only when they are the same wait (#1390 review).**
  - When `notifyInteractivePrompt` creates an interactive-assist prompt, the entry records the instance's
    `getInteractionSnapshot()` `owner` and `episode` (`daemon.ts:4294`) as `assistFor`.
  - An `awaiting_input` item is folded into that prompt (one row; the prompt's buttons win) **only** when the
    prompt is open, for the same instance, and its `assistFor` equals the current snapshot's `owner` and `episode`.
  - Otherwise both are listed. An old assist prompt (which persists, §3.1) never hides a new episode, such as a new
    dangerous-command dialog, so the new item keeps its own category and its own notification.
- **Resolved:** when the observation clears. That happens when a capture finds no evidence
  (`interaction-observation.ts:71-75`), when it goes stale after 15 s (`:107-109`), or on pause, freeze or respawn
  (`daemon.ts:5854, 9318, 10014`). An answer on any surface clears the terminal, and with it the item.
- **Gap fixed here:** the daemon emits `instance_interaction` (`daemon.ts:4314`), but nothing in the fleet listens.
  The web only learns at the next 10 s status. The implementation adds that listener, which recomputes the inbox
  (§4.2). No store is needed.

### 3.3 `instance`: an instance that cannot go on without the person

- **Paused for sign-in:** the pause marker's reason is `auth` (`pause-marker.ts:5-29`; `readPauseReason`). It is set
  at `instance-lifecycle.ts:1330-1343` and cleared by `clearPausedMarker` (`pause-marker.ts:38`).
  - `id = "auth:<instance>"`. Title "Paused: sign-in needed". Action **Open**; the instance's actions there include
    `/login` guidance.
  - The reason is read through a cached accessor that is refreshed when the fleet pauses or wakes the instance. It
    is not re-read from disk on every status.
- **Crashed:** `instanceProcessStatus === "crashed"` (`fleet-manager.ts:869`, set at `:2590`). `id =
  "crashed:<instance>:<crash time>"`, title "Crashed", action **Open** (its Start is there).
- **Not included in v1** (they don't wait on the person, or are already covered):
  - **stuck / hang:** the hang prompt (§3.1) is the actionable form;
  - **idle, operator or warm-cap pauses:** chosen, not waiting;
  - **rate limits:** a percentage, not a request;
  - **backend outages:** not the person's to fix.

### 3.4 `delivery`: a delivery the fleet itself says an operator should check

- **State:** the durable outbox (`delivery-outbox.ts`, `DeliveryOutbox` `:469`), rows with `state IN
  ('uncertain','failed')`.
  - On those transitions the fleet already posts "⚠️ Delivery to X could not be confirmed. Do not resend until an
    operator checks…" / "❌ …" to General (`fleet-manager.ts:1138-1144`; `locale.ts:751-752`). The inbox shows the
    same events and keeps them visible.
- **The acknowledgement lives on the row (#1390 review: outbox column, not a side file).**
  - **Columns:** an additive migration (`user_version` 4 → 5, the outbox's existing pattern at
    `delivery-outbox.ts:575-600`) adds `acknowledged_at TEXT` and `acknowledged_by TEXT` (§6.1 says what goes in
    `by`).
  - **Index:** a partial index, `CREATE INDEX idx_delivery_attention ON deliveries(finished_at) WHERE state IN
    ('uncertain','failed') AND acknowledged_at IS NULL`.
  - **No `COALESCE`:** every transition into `uncertain`/`failed` sets `finished_at` (`:994, 1101, 1198, 1217,
    1244, 1266, 1473`).
  - **The read-only operator CLI** (`agend delivery show`, which opens without migrations, `:883`) keeps working on
    an old file.
- **Query (new method):**

  ```sql
  SELECT … FROM deliveries
   WHERE state IN ('uncertain','failed') AND acknowledged_at IS NULL AND finished_at >= ?
   ORDER BY finished_at DESC LIMIT 50
  ```

  - **Acknowledged rows are excluded before the cap.** With 51 recent rows where the newest 50 are acknowledged,
    row #51 is still listed.
  - **The scan is bounded by the time range on the partial index.** Uncertain rows are never pruned, but rows
    older than 24 h are outside the range and are not examined. The regression runs `EXPLAIN QUERY PLAN`: it must
    use `idx_delivery_attention` with no temp B-tree for `ORDER BY`. It also seeds 1,000 expired uncertain rows plus
    a few recent ones and asserts that only the recent ones come back.
  - It is synchronous on the fleet loop, which is acceptable at this bound: an indexed range of at most 50 rows,
    computed at most once per change or 10 s tick (§4.3). It is never run per web request.
- **Acknowledge write:** `UPDATE deliveries SET acknowledged_at=?, acknowledged_by=? WHERE delivery_id=? AND state IN
  ('uncertain','failed') AND acknowledged_at IS NULL`. It is one statement, so it is atomic.
  - 0 rows changed means it is already acknowledged, delivered, or unknown. The answer is "already handled", and
    the surfaces re-render.
  - A write error (disk, a locked file) is reported to the clicker ("could not record the acknowledgement"). The
    item stays listed. Nothing is cached as acknowledged in memory.
- **Item:** `id = "delivery:<delivery_id>"`. Title "Could not confirm delivery" or "Delivery failed". Detail
  "<source> → <target>" plus the `kind`. `since` is `finished_at`. The instance is the target. Actions: open the
  target, and **Acknowledge**.
- **Resolved:**
  - `markConsumed` (`:1137`) turns an `uncertain` row into `delivered` when transcript proof arrives (`daemon.ts
    2003-2031`), and the item drops;
  - the 24 h window ages a row out;
  - **Acknowledge** from any surface: the General message's button, the DM, or the web. It removes the item
    everywhere (§5.3).

  The acknowledgement is two new columns on the existing row (above). It never adds an item, it only hides one.
- **Web-chat user messages that failed** (`WebChatHistory` deliveries `failed`; `web-chat-history.ts:26`;
  in-memory ring) are **not** inbox items. They already show `!` on the message itself, in the chat where it was
  sent. Telegram and Discord user messages that fail only get a reaction (`status-emojis.ts`) and leave nothing
  queryable but an event-log row without a chat id, so they are not items either.

### 3.5 What clears what (summary)

| Type | Appears when | Disappears when (any surface) | Re-render trigger |
|---|---|---|---|
| prompt | `postNonceButtonPromptOrThrow` | `consumeNonceCallback` (web / TG / DC click), expiry, stop, shutdown | existing `prompt` / `prompt_resolved` |
| awaiting_input | observation → `waiting` | observation clears (answered anywhere, stale, pause, respawn) | **new** fleet listener on `instance_interaction` |
| instance (auth) | pause reason `auth` | wake / `clearPausedMarker` | pause / wake transitions |
| instance (crashed) | `instanceProcessStatus = crashed` | restarted / stopped | status change |
| delivery | outbox → `uncertain` / `failed` | `uncertain → delivered` (proof), 24 h window, Acknowledge (any surface) | existing outbox `"state"` listener |

### 3.6 Not available: "the agent asked you something"

`reply` (`outbound-schemas.ts:18`) has no "this is a question" field. `requires_reply` / `request_kind` /
`reply_obligations` (`delivery-outbox.ts:554`) exist only between instances; the person is never a party. A user
question item would need a new signal: an agent-side flag or tool, plus where it is stored. That is outside "no new
source of truth", so it is a follow-up issue, not v1 (§8, Q3).


## 4. Server: one derivation

### 4.1 `FleetManager.getNeedsYou(): NeedsYouItem[]`

A pure function of the state in §3, minus acknowledged deliveries. It is computed on demand and not stored.

```ts
type NeedsYouType = "prompt" | "awaiting_input" | "instance" | "delivery";
interface NeedsYouItem {
  id: string;              // stable per occurrence (§3); a new episode/occurrence gets a new id
  type: NeedsYouType;
  instance: string;        // the instance to open; delivery → its target
  title: string;           // localized, one line (en / zh-TW by the fleet locale, as other fleet notices)
  detail: string;          // one line, may be ""
  since: number;           // epoch ms of when it started waiting
  nonce?: string;          // prompt: the prompt to answer (web: POST /ui/prompt)
  promptAt?: { adapterId: string; chatId: string; threadId?: string; messageId?: string };  // prompt: where its buttons are
  ackable?: boolean;       // delivery: Acknowledge offered
}
```

Ordering: by instance (the instance with the oldest item first), then oldest `since` first.

### 4.2 One change signal, three renderers

- **When it recomputes:**
  - the existing emit points: `prompt`, `prompt_resolved`, `activity`, status changes, the outbox `"state"`
    listener (`fleet-manager.ts:1138`);
  - **new:** a fleet listener for the daemon's `instance_interaction` (`daemon.ts:4314`), the pause/wake
    transitions, and an acknowledge;
  - a 10 s backstop.
- **When it is "changed"** (#1390 review): when the **rendered** list differs from the last one. That covers the ids
  in order, each item's displayed text (title, detail, age bucket) and its action coordinates: the prompt message it
  links to, and the owning world. A prompt re-posted elsewhere, or an instance moving worlds, therefore re-renders
  even though its id is the same.
- **Notification dedup is separate:** DMs (§5.5), the live message's "new item → new post" (§5.3) and browser
  notifications (§6.3) key on **ids never seen before**, not on the rendered signature. A re-render never notifies
  anyone twice.
- **What runs on a change:**
  - the **chat renderer** for each world (§5), debounced and rate-limited;
  - SSE `needs` to connected pages, plus a `needs` field on `/ui/poll` (§6);
  - the optional DM on newly appeared ids (§5.5).

### 4.3 Cost

A prompt-map scan, the instance presentations (already computed for `status`), cached pause reasons, and one
indexed outbox query (at most 50 rows, last 24 h). It runs per change and is cached per 10 s tick. No per-request
work is added to any endpoint the web calls on a timer.

## 5. Discord / Telegram (primary)

### 5.0 Visibility and authority: the owning world (decision, 2026-10-08)

- **Owning world.** An item belongs to the world that owns its instance: `getInstanceAdapterId(item.instance)`
  (`fleet-manager.ts:2342`), the same rule as #1346's owner gating. That is the configured `channel_id`, else the
  primary adapter, plus classic and external bindings. A delivery item's instance is its **target**. An item has an
  owning world only when that id is a live world (`this.worlds.has(owner)`).
- **Chat is scoped to it:**
  - each world's General live message lists **only** items whose owning world is that world (§5.1);
  - the admin DM (§5.5) goes only to that world's admins, and only for its items;
  - handling an item from chat (Acknowledge) is allowed only for an admin of the owning world,
    `isFleetAdmin(userId, owner)` (§5.2).
- **`/ui` is global.** The web view lists every item from every world and can handle any of them. A signed-in web
  session is already fleet-admin level (§6.1).
- **No owning world** (a web-only fleet, or an instance whose bound world is gone): the item appears **only in
  `/ui`**.

### 5.1 The live message

One message per world, in that world's General: `fleetNoticeTarget(adapterId)` (`fleet-manager.ts:9688`), the same
place the daily summary and fleet errors go. It lists only that world's items (§5.0); a world with none shows "✅
Nothing needs you right now".

```
📥 Needs you — 3
• alpha — Not responding (12 min) → [jump to its prompt]
• beta — Permission needed (3 min) · <#beta-thread>
• gamma ← delta — Could not confirm delivery (25 min) · <#gamma-thread>      [Acknowledge gamma]
```

- **Jump targets**, built by a new pure helper (`chatLink`):
  - **Prompt items** link to the prompt's own message, where its existing buttons work as today. On Discord that is
    `https://discord.com/channels/<guild>/<channel>/<message>`; on a Telegram forum it is
    `https://t.me/c/<id>/<topic>/<message>`.
  - **Other items** link to the instance's thread: Discord `<#channel>` (rendered as a clickable channel), Telegram
    `https://t.me/c/<id>/<topic>`.
  - If no link can be built (a private Telegram group without topics, say), the line is shown without one.
- **When nothing is waiting**, the message is edited to "✅ Nothing needs you right now" rather than deleted.
- **Size:** at most 10 lines, then "… and N more: open /ui". There is at most one Acknowledge button per delivery
  item: the newest 5 (Discord: one action row of five; Telegram: one keyboard row each).

### 5.2 Buttons on the live message: Acknowledge only

- **Prompt capabilities stay where they are.** A prompt's nonce is bound to the chat, thread and message that
  posted it, and a click from anywhere else is refused as "wrong place" (`consumeNonceCallback`,
  `fleet-manager.ts:10036-10056`). The live message therefore **links** to the prompt instead of copying its
  buttons, and the capability model doesn't change.
- **Acknowledge** is a new nonce prefix, `needs-ack:`, with the same 128-bit nonce and the same binding checks as
  every other button (`consumeNonceCallback`).
- **Authorization:** an admin of the owning world, `isFleetAdmin(userId, callbackAdapterId)`. The handler then
  re-checks `getInstanceAdapterId(item.instance) === callbackAdapterId` and that the row is still unacknowledged
  (§5.0, §3.4).
- **Not registered through `postNonceButtonPromptOrThrow`.** That gives a prompt-style lifecycle, whose 15-minute
  expiry edits the message to its expired text and would overwrite the live list. The live message owns its
  capabilities instead (§5.2a).

### 5.2a The live message's capabilities: one generation per render (#1390 review)

- **Generations.** Each world's renderer has a `generation` counter. A render mints fresh `needs-ack:` nonces for
  the delivery items it shows and registers them in `pendingNonceButtons` with `{ generation, world, silentExpiry:
  true }`.
- **Revoke before await.** Before the render's first `await` (the post or edit), the previous generation's entries
  are **deleted from the map and their timers cleared**. They are not just edited. From that moment an old button is
  stale, whether or not the edit lands.
- **Silent expiry.** The entries' timer only deletes the entry; it never edits the message. The live message is
  re-rendered at least every 10 minutes (the ages change anyway). So a list left alone for more than 15 minutes
  keeps working buttons and is never overwritten by expiry text.
- **Stale clicks never edit the live message.** A click on a revoked, expired or other-generation `needs-ack:`
  nonce takes a new stale mode, `staleHandling: { noEdit: true }`: it only answers the clicker ("This list has been
  updated — use the current one"). It does **not** call `editMessageRemoveButtons` or `removeMessageButtons`, which
  would strip the renewed keyboard of that same message. The same applies to a held callback that arrives after a
  replacement (§5.3).
- **Text and buttons are replaced together** with the adapters' `editAlert` (Discord `discord.ts:1829`, Telegram
  `telegram.ts:1353`). Plain `editMessage` clears Telegram's keyboard.
- **After a restart** no nonce survives, because the map is in memory. The first render after start (§5.4) mints
  fresh ones and replaces the persisted message's keyboard. Clicks on pre-restart buttons are stale (noEdit).

### 5.3 Keeping it live without flooding

- **Something resolved or aged:** the message is edited in place with `editAlert`. Edits are debounced by 3 s and
  limited to one per 10 s per world.
- **A new item appears:** the old message is **deleted and a new one posted**. It moves to the bottom and the
  platform notifies people, at most once per 60 s per world. A new item inside that window is folded into an
  edit, and the next allowed post carries it.
- **An edit or delete fails** (Telegram refuses edits on messages older than 48 h, or the message is gone): a new
  message is posted, and the pointer moves to it.
- **On shutdown** this generation's capabilities are revoked first. Then the message is edited to "Fleet stopped;
  this list resumes when it starts" with no buttons.
- **One renderer per world** (adapter id), not per platform. Two Discord worlds have two messages, two pointers and
  two generations. The existing global notices (fleet errors and status in the primary General) are unchanged.

### 5.3a One renderer at a time, and late answers (#1390 review)

- **Single flight.** Each world's renderer runs one render at a time; a change while a render is in flight
  schedules exactly one follow-up. A render captures `{ generation, target, enabled }` when it starts.
- **Fences after every await** (the post, edit or delete ACK): the render continues only if
  - its generation is still current;
  - `needs_you.live_message` is still on;
  - the world still exists;
  - `fleetNoticeTarget(world)` still equals the captured target;
  - the fleet is not shutting down.

  If any fence fails, it does **not** persist the pointer and does **not** register capabilities. A post whose ACK
  arrives late is deleted best effort, so a disabled, rebound or stopped fleet never publishes a fresh list with
  live buttons.

### 5.4 Where the message is, across restarts

- **The record:** `<AGEND_HOME>/needs-you-message.json` = `{ "<adapterId>": { chatId, threadId?, messageId } }`,
  written atomically after a fenced, successful post (§5.3a).
- **Reused only at the same place.** On start, the pointer is reused only if its **canonical** `{chatId, threadId}`
  equals the current `fleetNoticeTarget(adapterId)`, canonicalised the same way. On Telegram the General topic `1`
  is "no thread", the form the provider uses, so `"1"` and omitted compare equal.
- **When the target moved** (a new guild, group or General) the old message is **not** edited with the current
  list, because that would post this world's current incidents to its former destination. It is deleted best
  effort, without new content, and a new message is posted at the current target.
- **Otherwise** the start render edits the old message to the current list with fresh capabilities (§5.2a), and
  posts a new one if the edit fails.

This is a pointer to a message, not a source of items.

### 5.5 DM to admins (optional, off by default)

- **Setting:** `needs_you.dm: true` (fleet-level, hot-reloadable).
- **Behaviour:** when an item id **appears**, each fleet admin **of the item's owning world** gets one short DM
  (that world's `access.allowed_users`, the list `isFleetAdmin` reads, `fleet-manager.ts:3047`), e.g. "📥 alpha — Not responding" with the jump link. Admins of other worlds do not get it,
  and items with no owning world are never DMed (§5.0). On Discord this goes through the adapter's `sendDirect`. On Telegram it goes
  to the private chat with the bot, only if the admin has started it; otherwise it is skipped silently.
- At most one DM per admin per 60 s, folding several new items into one message. `awaiting_input` items are DMed
  only once they are ≥ 5 s old (as in §6.3). The list and the live message are not delayed. There are no buttons in the DM:
  the jump link goes to where the buttons are.

### 5.6 Settings

```yaml
needs_you:
  live_message: true     # default true: the General message (§5.1); false turns it off per fleet
  dm: false              # default false (§5.5)
```

Both are fleet-level and hot-reloadable. Turning `live_message` off edits the existing message to "Turned off" and
forgets its pointer.

## 6. Web (presentation of the same list)

### 6.1 The view

- **Global.** The view lists every item from every world, plus items with no owning world, and any of them can be
  handled here: a signed-in web session is fleet-admin level (§5.0).
- **Sidebar.** **Needs you**, with a count badge (hidden at 0), above *Fleet*. The tab title gets a `(N)` prefix.
- **The view.** Grouped by instance as in §4.1. Each row shows an icon, the title, the detail, the age, and actions:
  - **prompts:** their own buttons, through the existing `POST /ui/prompt`. That is a session write plus CSRF; the
    server claims the prompt once, whoever answers first;
  - **everything:** **Open**, which sets `#instance=<name>`;
  - **delivery:** **Acknowledge** (`POST /ui/needs/ack {id}`, a session write plus CSRF), which clears it
    everywhere. It runs the same atomic `UPDATE` as chat (§3.4).
- **Who acknowledged.** `acknowledged_by` records a principal, never a credential:
  - chat: `discord:<userId>` / `telegram:<userId>`;
  - web: `web:<session handle>`, the 16-hex public handle from `web-session.ts`, never the session id or a hash of
    it;
  - the CLI's header token: `cli`.
- **Deep link.** `/ui#instance=<name>` opens that instance's chat. It is read on load and on `hashchange`, entirely
  client-side.
- **Build rules:** `createElement` plus `textContent`, classes in the nonce'd stylesheet, and `data-act` for actions.
  No style attribute and no inline handler (#1300 / #1268).

### 6.2 Channels and sessions (#1374)

- The list arrives over the existing passive channels only: SSE `needs` (on connect and on change) and a `needs`
  field on `/ui/poll`.
- **No new GET endpoint, and no timer-driven request is added**, so the inbox can never keep an idle session
  alive. The tests assert that the `isPassiveWebRead` allowlist is unchanged.
- The one new endpoint is the `POST /ui/needs/ack` write. It is a person's action and counts as use.
- **Through #1367's public link:** `public-web-gateway.ts` only forwards routes on its manifest (`:18`) and refuses
  everything else (`:68`). The PR adds exactly `POST /ui/needs/ack` to the `/ui` POST list, so an HTTPS (tunnel)
  user can acknowledge. The gateway tests cover it:
  - a scoped gateway session with CSRF succeeds;
  - no CSRF is refused;
  - a closed exposure is refused;
  - the route is not reachable with any other method;
  - nothing else is added.

### 6.3 Browser notifications (per device, opt-in): desktop browsers in v1

- **Scope, chosen (#1390 review):** v1 uses the page's `new Notification()`, which works in desktop browsers
  (Chrome, Edge, Firefox, Safari) while a `/ui` tab is open. The constructor is not supported in nearly all mobile
  browsers, and iOS allows notifications only to Home Screen web apps, through Push. So v1 does **not** offer the
  toggle on mobile (feature-detected: the constructor throws or is missing). The UI says that **on a phone, the
  Discord notification is the one to rely on**: a new item is a new post in General (§5.3), plus the optional DM
  (§5.5). A service-worker-based notification for mobile is part of the Web Push follow-up below, not v1.
- **Opt-in:** a "Notify me on this device" toggle in the view. It calls `Notification.requestPermission()` on that
  click, and only then. The choice is stored per device (`localStorage.agend_needs_notify`).
- **When:** while the page is hidden, for an item id this page has not seen. `awaiting_input` items notify only
  once they are ≥ 5 s old, so a dialog AgEnD answers by itself never pings anyone. **The list itself is never
  delayed:** an item shows the moment it is derived. The title is the instance, the body the item title, and
  `tag = item.id`. A click focuses the tab and opens the instance.
- **Constraints, stated in the UI:**
  - it needs a secure context: localhost/127.0.0.1 or #1367's HTTPS link work, a plain-HTTP LAN address does not;
  - a `/ui` tab must be open;
  - not offered on mobile (above).

  Discord's notification (§5.3) is the one that works with every tab closed.
- **Real Web Push** (a service worker, VAPID keys, a subscription store, and calls to vendor push services) is a
  follow-up with its own security review, not v1.

## 7. Lifecycle tests (implementation)

- **Per type, through the real derivation:**
  - **prompt:** appears in `getNeedsYou()`, the live message (with a jump link to the prompt message), SSE `needs`
    and `/ui/poll`. A **Discord** click on the prompt's own button (`receiveAdapterCallback`) removes it from the
    live message (an edit) and from the web, with no web action. The same holds for a Telegram click, a web
    answer, expiry, a stop and shutdown.
  - **awaiting_input:** appears as soon as `instance_interaction` reaches `waiting`, pushed rather than waiting for
    the 10 s tick. It clears when the observation clears.
    - It folds into an interactive-assist prompt **only** with the same owner and episode.
    - The sequence "old assist prompt open → its wait clears → a new dangerous-command episode" lists **both**: the
      new item keeps its category and notifies once.
  - **instance:** an `auth` pause appears and a wake clears it; `crashed` appears and a restart clears it.
  - **delivery:** an `uncertain` row appears; `markConsumed` makes it delivered and it is gone.
    - **Ack before the cap:** 51 recent rows with the newest 50 acknowledged list row #51.
    - **A bounded scan:** `EXPLAIN QUERY PLAN` uses `idx_delivery_attention` for the range with no temp B-tree, and
      1,000 expired uncertain rows plus 3 recent ones list exactly the 3.
    - **The migration:** a v4 file gains the columns and index, and an operator read of an old file still works.
    - **A write failure on ack** reports to the clicker and keeps the item listed. Acknowledge works the
    same from the Discord button, the Telegram button and the web: an admin from any surface clears every surface,
    and a non-admin is refused. A `failed` row ages out after 24 h on a controlled clock.
- **Visibility (§5.0):**
  - with two worlds (A owns alpha, B owns beta), A's live message and DMs list only alpha's items, B's only beta's;
  - `/ui` lists both;
  - an instance with no live owning world appears only in `/ui`;
  - an Acknowledge clicked by B's admin on A's message is refused by the binding;
  - A's message clicked by a user who is an admin of B but not of A is refused;
  - an ack whose instance moved to another world is refused;
  - the web can acknowledge any item.
- **Live message mechanics**, on a controlled monotonic clock:
  - edit vs. replace, the debounce and the rate limits;
  - a fallback post when an edit fails;
  - retirement on shutdown, with capabilities revoked first.
- **Capabilities (§5.2a):**
  - **More than 15 min untouched:** the message is renewed and its buttons work. Expiry never edits the message.
  - **Renewal, then a click on an old-generation button:** refused as stale, and the message's current keyboard
    is intact (no edit call).
  - **Replacement plus a held callback** from the deleted message: stale, with no edit to either message.
  - **Restart:** the first render rebinds fresh nonces, and pre-restart buttons are stale.
  - **Telegram and Discord both** go through `editAlert`, so text and keyboard change together.
- **Pointer and fences (§5.3a, §5.4):**
  - a restart with the same target reuses the pointer, with Telegram General `"1"` equal to omitted;
  - a restart after the target changed (a new group or guild, or a new General) never edits the old message with
    current items, and posts at the new target;
  - a late post or edit ACK after `live_message: false`, a world rebind, or shutdown does not persist the pointer or
    register capabilities, and a late post is deleted best effort;
  - concurrent changes produce one render in flight plus one follow-up.
- **Two Discord worlds with different admins:** each world's message, DMs and Acknowledge are scoped as in
  Visibility above. `/ui` lists and controls both. The existing primary-General fleet errors and status messages are
  unchanged.
- **Public gateway:** the exact `POST /ui/needs/ack` manifest entry; a scoped session plus CSRF succeeds; no CSRF
  or a closed exposure is refused; no other route is added.
- **DM:** off by default; one per admin per window; folding; a Telegram admin who never started the bot is skipped.
- **Web:** the `isPassiveWebRead` allowlist is unchanged and no new GET route exists. Plus a vm harness and a
  real-browser smoke under the real CSP (badge, grouping, Open via the hash, prompt answer once, Acknowledge,
  notify toggle) with no style attribute and zero CSP violations.
- **Mutations** for every clearing path, every source filter, the binding of the ack capability, and the rate limits.

## 8. Decisions (after review)

1. **Answering in place:** **links**, which preserve the existing capability model. No proxy in v1.
2. **The ack** lives on the outbox row (§3.4), which gives atomic selection and write.
3. **"Agent asked you"** is a follow-up issue (a new signal), not v1.
4. **Defaults:** `live_message` on, `dm` off, a new post at most once per 60 s per world.
5. **`awaiting_input` notifications** (DM, browser) wait until the item is ≥ 5 s old. The list and the live message
   are never delayed.
6. **Visibility** (the leader): chat is scoped to the owning world, and `/ui` is global (§5.0).

## 9. Implementation plan

- **PR (a), server + chat:**
  - `getNeedsYou` and the recompute signal;
  - the `instance_interaction` listener and the outbox query;
  - the live message, with its renderer, pointer and rate limits;
  - Acknowledge (the `needs-ack:` prefix with its generation lifecycle, and the outbox migration), the DM and the
    settings;
  - the public-gateway manifest entry;
  - SSE `needs` and `/ui/poll`;
  - tests.
- **PR (b), web:** the view, the badge, the hash deep link, Acknowledge on the web, browser notifications, and the
  real-browser smoke.
