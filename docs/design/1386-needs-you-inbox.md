# #1386 — "Needs you": one list of everything waiting on the user (design)

Status: design for review, revised for the user's scope (2026-10-08). Milestone 2.2.0. Reference: todos.dev's inbox
(https://todos.dev/docs/inbox) and fable's report "todos dev vs AgEnD" (§4, §5.1).

## 1. Goal and non-goals

**Goal.** Discord is where people act, and the web shows the same list. There is one list of everything currently
waiting on the person, across every instance, **derived from existing state** (§3).

- **Discord (and Telegram): the primary surface.** Each platform's General has one live **Needs you** message
  that is kept up to date. Every item in it is one tap from where it is acted on: the prompt's own message with its
  existing buttons, or the instance's thread. The only new button is **Acknowledge** for delivery items, which
  have no button today (§5). Optionally, fleet admins also get a DM when a new item appears.
- **Web: the same list, presented.** `/ui` gets a Needs you view and a sidebar badge, with one tap to the
  instance's chat. A device can opt in to browser notifications (§6).
- **Resolved anywhere, gone everywhere.** All surfaces are renderings of one derivation (§4). An answer on
  Discord, Telegram or the web changes the underlying state, and every surface re-renders from it.

**Non-goals (v1).**
- **No new source of truth for items.** The server keeps two small records, and neither decides what is listed:
  - where each platform's live message is (§5.4);
  - which delivery items were acknowledged (§3.4), the one new piece of state (§8 Q2).
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
- **De-duplication:** when an `interactive-assist` prompt is open for the same instance, the `awaiting_input` item
  is folded into it (one row; the prompt's buttons win).
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
- **Query (new method, existing index):** `listNeedsAttention(sinceMs)`, i.e. `SELECT … WHERE state IN
  ('uncertain','failed') AND COALESCE(finished_at, created_at) >= ? ORDER BY created_seq DESC LIMIT 50`, served by
  `idx_delivery_state_seq` (`:513`). The window is the last 24 h. It is read-only.
- **Item:** `id = "delivery:<delivery_id>"`. Title "Could not confirm delivery" or "Delivery failed". Detail
  "<source> → <target>" plus the `kind`. `since` is `finished_at`. The instance is the target. Actions: open the
  target, and **Acknowledge**.
- **Resolved:**
  - `markConsumed` (`:1137`) turns an `uncertain` row into `delivered` when transcript proof arrives (`daemon.ts
    2003-2031`), and the item drops;
  - the 24 h window ages a row out;
  - **Acknowledge** from any surface: the General message's button, the DM, or the web. It removes the item
    everywhere (§5.3).

  The outbox has no acknowledge column, so acknowledgements are kept in `<AGEND_HOME>/needs-you-acks.json`
  (`{ "<delivery_id>": { "at": <ms>, "by": "<surface>:<user>" } }`, written atomically and pruned with the 24 h
  window). This is the **one new piece of state**. It never adds an item, it only hides one; §8 Q2 has the
  alternative of an outbox column.
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
- **When it is "changed":** when the list's signature (ids in order, plus each item's age bucket for the
  displayed ages) differs from the last one.
- **What runs on a change:**
  - the **chat renderer** for each platform (§5), debounced and rate-limited;
  - SSE `needs` to connected pages, plus a `needs` field on `/ui/poll` (§6);
  - the optional DM on newly appeared ids (§5.5).

### 4.3 Cost

A prompt-map scan, the instance presentations (already computed for `status`), cached pause reasons, and one
indexed outbox query (at most 50 rows, last 24 h). It runs per change and is cached per 10 s tick. No per-request
work is added to any endpoint the web calls on a timer.

## 5. Discord / Telegram (primary)

### 5.1 The live message

One message per platform, in that platform's General: `fleetNoticeTarget(adapterId)` (`fleet-manager.ts:9688`), the
same place the daily summary and fleet errors go.

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
  buttons. One tap reaches the existing, already-authorized buttons. The capability model doesn't change, and two
  taps replace a new cross-message answer path. (§8 Q1 asks whether a later "answer here" proxy is wanted.)
- **Acknowledge** is a new nonce prefix, `needs-ack:`, posted through `postNonceButtonPromptOrThrow`. So it gets
  the same 128-bit nonce, the same binding to the live message, and fleet-admin authorization (`isFleetAdmin` on
  the clicking adapter), exactly like every other mutating button. A click records the ack, recomputes, and
  re-renders every surface.
- When the live message is replaced (§5.3), its Acknowledge nonces are retired with it (the existing
  `retireNonceButtons`), and the new message gets fresh ones. A click on an old message gets the standard "this
  button has expired".

### 5.3 Keeping it live without flooding

- **Something resolved or aged:** the message is **edited in place**. Discord's `editMessage` with the components
  replaced; on Telegram, text plus keyboard. Edits are debounced by 3 s and limited to one per 10 s per platform.
- **A new item appears:** the old message is **deleted and a new one posted**. It moves to the bottom and the
  platform notifies people, at most once per 60 s per platform. A new item inside that window is folded into an
  edit, and the next allowed post carries it.
- **An edit or delete fails** (Telegram refuses edits on messages older than 48 h, or the message is gone): a new
  message is posted, and the pointer moves to it.
- **On shutdown** the message is edited to "Fleet stopped; this list resumes when it starts" and its buttons are
  removed, matching how prompts are retired today.

### 5.4 Where the message is, across restarts

`<AGEND_HOME>/needs-you-message.json` = `{ "<adapterId>": { chatId, threadId, messageId } }`, written atomically.
On start, the fleet edits that message to the current list, or posts a new one if the edit fails. Without this
record, every restart would leave a stale list behind. This is a pointer to a message, not a source of items.

### 5.5 DM to admins (optional, off by default)

- **Setting:** `needs_you.dm: true` (fleet-level, hot-reloadable).
- **Behaviour:** when an item id **appears**, each fleet admin of that platform gets one short DM, e.g. "📥 alpha —
  Not responding" with the jump link. On Discord this goes through the adapter's `sendDirect`. On Telegram it goes
  to the private chat with the bot, only if the admin has started it; otherwise it is skipped silently.
- At most one DM per admin per 60 s, folding several new items into one message. There are no buttons in the DM:
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

- **Sidebar.** **Needs you**, with a count badge (hidden at 0), above *Fleet*. The tab title gets a `(N)` prefix.
- **The view.** Grouped by instance as in §4.1. Each row shows an icon, the title, the detail, the age, and actions:
  - **prompts:** their own buttons, through the existing `POST /ui/prompt`. That is a session write plus CSRF; the
    server claims the prompt once, whoever answers first;
  - **everything:** **Open**, which sets `#instance=<name>`;
  - **delivery:** **Acknowledge** (`POST /ui/needs/ack {id}`, a session write plus CSRF), which clears it
    everywhere.
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

### 6.3 Browser notifications (per device, opt-in)

- **Opt-in:** a "Notify me on this device" toggle in the view. It calls `Notification.requestPermission()` on that
  click, and only then. The choice is stored per device (`localStorage.agend_needs_notify`).
- **When:** while the page is hidden, for a new item id. The title is the instance, the body the item title, and
  `tag = item.id`. A click focuses the tab and opens the instance.
- **Constraints, stated in the UI:**
  - it needs a secure context: localhost/127.0.0.1 or #1367's HTTPS link work, a plain-HTTP LAN address does not;
  - a `/ui` tab must be open;
  - on iOS, only a Home Screen web app may notify.

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
    the 10 s tick. It folds into an interactive-assist prompt, and clears when the observation clears.
  - **instance:** an `auth` pause appears and a wake clears it; `crashed` appears and a restart clears it.
  - **delivery:** an `uncertain` row appears; `markConsumed` makes it delivered and it is gone. Acknowledge works the
    same from the Discord button, the Telegram button and the web: an admin from any surface clears every surface,
    and a non-admin is refused. A `failed` row ages out after 24 h on a controlled clock.
- **Live message mechanics:** edit vs. replace, the debounce and rate limits on a controlled clock, a fallback post
  when an edit fails, the pointer persisted and resumed after a restart, retirement on shutdown, and expired-button
  handling on a replaced message.
- **DM:** off by default; one per admin per window; folding; a Telegram admin who never started the bot is skipped.
- **Web:** the `isPassiveWebRead` allowlist is unchanged and no new GET route exists. Plus a vm harness and a
  real-browser smoke under the real CSP (badge, grouping, Open via the hash, prompt answer once, Acknowledge,
  notify toggle) with no style attribute and zero CSP violations.
- **Mutations** for every clearing path, every source filter, the binding of the ack capability, and the rate limits.

## 8. Open questions for review

1. **Answering in place.** v1 links each item to the prompt's own message rather than copying its buttons, which
   would need a cross-message proxy capability. Is the extra tap acceptable, or should a later PR add a proxy? It
   would claim the original nonce through a trusted internal path, as the web click does today.
2. **Where the ack lives.** A small `needs-you-acks.json` (proposed), or an `acknowledged_at` column on the outbox,
   which would need a migration but keeps it with the row?
3. **"Agent asked you"** needs a new signal (e.g. `reply(…, needs_answer: true)` recorded in the web chat history).
   Follow-up issue?
4. **Defaults:** `live_message` on, `dm` off. Is a new post at most once per 60 s right for Discord's noise?
5. **`awaiting_input` notifications** (DM and browser): only after the item is ≥ 5 s old, so a dialog AgEnD answers
   by itself never pings anyone?

## 9. Implementation plan

- **PR (a), server + chat:**
  - `getNeedsYou` and the recompute signal;
  - the `instance_interaction` listener and the outbox query;
  - the live message, with its renderer, pointer and rate limits;
  - Acknowledge (the nonce prefix and the ack store), the DM and the settings;
  - SSE `needs` and `/ui/poll`;
  - tests.
- **PR (b), web:** the view, the badge, the hash deep link, Acknowledge on the web, browser notifications, and the
  real-browser smoke.
