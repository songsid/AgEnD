# #1386 — "Needs you": one list of everything waiting on the user (design)

Status: design for review. Milestone 2.2.0. Reference: todos.dev's inbox (https://todos.dev/docs/inbox) and fable's
report "todos dev vs AgEnD" (§4, §5.1).

## 1. Goal and non-goals

**Goal.** `/ui` gets a **Needs you** view and a sidebar badge. It lists everything currently waiting on the person,
across every instance. Each item shows the instance, the reason, its age and one primary action (answer, open, or
dismiss), and opens that instance's chat in one tap. An item disappears once it is resolved anywhere: the web,
Telegram or Discord. A device can opt in to a notification when a new item appears. An optional, off-by-default
digest can go to General.

**Non-goals (v1).**
- **No new source of truth.** Every item is computed from state the fleet already holds (§3). The inbox stores
  nothing on the server. The one per-device choice it keeps, which items this browser dismissed and whether this
  device wants notifications, lives in that browser's `localStorage`. It is a view preference, not state.
- No board view (#1387) and no diff review (#1388).
- No server-side Web Push in v1: no service worker, no VAPID keys, no subscription store. It is costed in §6.3 as a
  follow-up.
- No "agent asked the user a question" item. Nothing records that today (§3.6), and adding it would be a new source.

## 2. What the person sees

- **Sidebar.** Above *Fleet*: **Needs you**, with a count badge (hidden at 0). The browser tab title gets a `(N)`
  prefix while N > 0.
- **View.** Items are grouped by instance, newest instance group first. Each row shows:
  - an icon by type;
  - the title (one line);
  - the detail (one line, may be empty);
  - the age ("4 min");
  - its actions. A prompt shows its own buttons, the same ones Telegram has. Every other item shows **Open**, and a
    delivery item also shows **Dismiss**.

  An empty view says "Nothing needs you".
- **Deep link.** `/ui#instance=<name>` opens that instance's chat. The hash is read on load and on `hashchange`.
  It is client-side only: no new route, nothing sent to the server. Every row's **Open** uses it, and so does the
  notification's click.

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
  "<source> → <target>" plus the `kind`. `since` is `finished_at`. The instance is the target. Actions: **Open**
  the target, and **Dismiss**.
- **Resolved:**
  - `markConsumed` (`:1137`) turns an `uncertain` row into `delivered` when transcript proof arrives (`daemon.ts
    2003-2031`), and the item drops;
  - the 24 h window ages a row out;
  - **Dismiss** hides it on that device.

  There is no server-side acknowledge. The outbox has no such column, and adding one would make this a source of
  truth (§7, Q2).
- **Web-chat user messages that failed** (`WebChatHistory` deliveries `failed`; `web-chat-history.ts:26`;
  in-memory ring) are **not** inbox items. They already show `!` on the message itself, in the chat where it was
  sent. Telegram and Discord user messages that fail only get a reaction (`status-emojis.ts`) and leave nothing
  queryable but an event-log row without a chat id, so they are not items either.

### 3.5 What clears what (summary)

| Type | Appears when | Disappears when (any surface) | Push trigger |
|---|---|---|---|
| prompt | `postNonceButtonPromptOrThrow` | `consumeNonceCallback` (web / TG / DC click), expiry, stop, shutdown | existing `prompt` / `prompt_resolved` |
| awaiting_input | observation → `waiting` | observation clears (answered anywhere, stale, pause, respawn) | **new** fleet listener on `instance_interaction` |
| instance (auth) | pause reason `auth` | wake / `clearPausedMarker` | pause / wake transitions |
| instance (crashed) | `instanceProcessStatus = crashed` | restarted / stopped | status change |
| delivery | outbox → `uncertain` / `failed` | `uncertain → delivered` (proof), 24 h window, per-device dismiss | existing outbox `"state"` listener |

### 3.6 Not available: "the agent asked you something"

`reply` (`outbound-schemas.ts:18`) has no "this is a question" field. `requires_reply` / `request_kind` /
`reply_obligations` (`delivery-outbox.ts:554`) exist only between instances; the person is never a party. A user
question item would need a new signal: an agent-side flag or tool, plus where it is stored. That is outside "no new
source of truth", so it is a follow-up issue, not v1 (§7, Q3).

## 4. Server: one derivation, existing channels

### 4.1 `FleetManager.getNeedsYou(): NeedsYouItem[]`

A pure function of the state above, computed on demand. It is not stored.

```ts
type NeedsYouType = "prompt" | "awaiting_input" | "instance" | "delivery";
interface NeedsYouItem {
  id: string;              // stable per occurrence; see §3 (a new episode/occurrence gets a new id)
  type: NeedsYouType;
  instance: string;        // the instance to open; delivery → its target
  title: string;           // localized, one line
  detail: string;          // localized/derived, one line, may be ""
  since: number;           // epoch ms of when it started waiting
  actions: Array<{ id: string; label: string; kind: "prompt" | "open" | "dismiss" }>;
  nonce?: string;          // prompt only: what POST /ui/prompt takes
}
```

Ordering: oldest `since` first within an instance, and instances by their oldest item. Prompt text, summaries and
delivery details are the strings each surface already shows, rendered with `textContent` only.

### 4.2 How the page gets it: the existing passive channels only

- **SSE.** A new event, `needs`, carries the full list. It is sent on connect (with `status`, `prompts`) and
  whenever the list's signature (its ids, in order) changes. Recomputation is triggered by the existing emit points
  (`prompt`, `prompt_resolved`, `activity`, status changes, the outbox `"state"` listener), plus the **new**
  `instance_interaction` listener and pause/wake transitions. The SSE heartbeat (10 s) recomputes as a backstop.
- **`/ui/poll`** gets a `needs` field next to `prompts`. The stream-down fallback sees the same list.
- **Sessions (#1374):** both channels are already passive (`isPassiveWebRead`). **No new endpoint is added**, and
  in particular none on a timer, so the inbox can never keep an idle session alive. The tests assert that the
  allowlist is unchanged.
- **Answers** use the existing `POST /ui/prompt` (a write: it needs the session plus CSRF, and counts as use).
  **Open** and **Dismiss** are client-only.

### 4.3 Cost

A prompt list scan, an instance presentation per instance (already computed for `status`), cached pause reasons, and
one indexed outbox query (at most 50 rows, last 24 h). It runs on change, plus once per 10 s heartbeat per connected
stream; the result is cached for the heartbeat tick, so N streams cost one computation.

## 5. `/ui`

- **Sidebar entry and view** as in §2.
  - Built with `createElement` and `textContent`, styled by classes in the page's nonce'd stylesheet. No style
    attribute and no inline handler (#1300 / #1268); actions use `data-act`.
- **Prompt actions** reuse the chat's prompt-answer path, so one click from either place counts once. The server
  already guarantees this (`consumeNonceCallback`).
- **Dismiss** (delivery items only) stores the id in `localStorage.agend_needs_dismissed`, capped at 200 ids; ids
  that are no longer listed are pruned. A storage that can't be read means nothing is hidden.
- **Badge** is the count of listed, not-dismissed items. `document.title` gets a `(N)` prefix.

## 6. Notifications

### 6.1 Per-device browser notification (v1)

- **Opt-in:** a toggle in the Needs you view, "Notify me on this device". It calls
  `Notification.requestPermission()` on that click, and only then. The choice is stored per device
  (`localStorage.agend_needs_notify`).
- **When:** an item id appears that this page has not seen before (seen ids are kept per page load and seeded from
  the first `needs`). The notification is shown only while the page is hidden (`document.visibilityState !==
  "visible"`). Its title is the instance and its body the item title. `tag = item.id` makes the browser replace,
  not stack, repeats. A click focuses the tab and sets `#instance=<name>`.
- **Constraints, stated in the UI:**
  - The Notification API needs a secure context. `http://localhost` / `127.0.0.1` qualify, and so does the #1367
    HTTPS public link. Plain-HTTP LAN addresses do not, and the toggle says why.
  - It works only while some `/ui` tab is open; a closed browser gets nothing (§6.3).
  - On iOS, only a Home Screen web app may notify.

### 6.2 Optional General digest (off by default)

- **Setting:** `web.needs_digest` (default `false`). Hot-reloadable like `web.notify_login`.
- **Behaviour:** when an item has waited **30 minutes** and has not been in a digest before, one message goes to
  each platform's General (`fleetNoticeTarget`), at most once per 30 minutes. For example: "📥 3 things have been
  waiting on you for 30+ min: A (permission), B (could not confirm delivery), …". The message has a link to `/ui`
  only when the dashboard has a non-loopback origin (`hostname` / #1367).
- Which ids have been in a digest is kept in memory. A restart may repeat a digest once; that is acceptable for a
  reminder and avoids a store.
- Prompts already appear in their topic. The digest exists for the item types that do not ping (`awaiting_input`,
  `delivery`), and for people who stopped watching topics.

### 6.3 Follow-up, not v1: real Web Push

Notifications with no tab open need four things:
- a service worker (same-origin script; CSP `worker-src 'self'`);
- VAPID keys;
- a persisted store of push subscriptions per device (a new store);
- the fleet calling the browser vendor's push service, which is an outbound network dependency.

It only works on a secure origin, which in practice means #1367's public link. That is a separate issue with its own
security review (subscription lifetime, revocation on sign-out, payload contents).

## 7. Open questions for review

1. **`awaiting_input` noise.** An auto-answered dialog passes the 500 ms confirmation only rarely. Should the inbox
   require the item to be ≥ 5 s old before it shows (and notifies)? Recommended: yes for notification, no for the
   list, so the list stays consistent with the existing *needs you* badge.
2. **Delivery dismiss:** per device (v1, no store) or fleet-wide (needs an `acknowledged_at` column on the outbox,
   i.e. state)? Recommended: per device now. Revisit if operators share a fleet.
3. **"Agent asked you":** file a follow-up for an explicit signal (e.g. `reply(…, needs_answer: true)` recorded in
   the web chat history), or leave it to the chat itself? Recommended: a follow-up issue.
4. **Digest default** off, with a 30 min threshold: OK?

## 8. Tests (implementation PRs)

- **Lifecycle per type:**
  - **prompt:** appears in `getNeedsYou()` and SSE `needs`. Answered via a TG/DC callback (`receiveAdapterCallback`),
    it is gone from the next `needs` without any web action. It also goes on web answer, expiry, stop and shutdown.
  - **awaiting_input:** appears once `instance_interaction` reaches `waiting` (pushed immediately, not at the
    heartbeat). It folds into an interactive-assist prompt. It clears when the observation clears.
  - **instance:** `auth` pause appears, and wake clears it. `crashed` appears, and restart clears it.
  - **delivery:** an `uncertain` row appears; `markConsumed` makes it `delivered`, and it is gone. `failed` appears
    and ages out after 24 h on a controlled clock. Rows outside the window, or in other states, never appear.
- **Channels:** `needs` arrives on SSE connect and on change, and `/ui/poll` carries it. The `isPassiveWebRead`
  allowlist is unchanged, and no new GET route exists.
- **UI** (vm harness + real-browser smoke under the real CSP):
  - badge and title count;
  - grouping;
  - Open sets the hash and opens the chat;
  - prompt buttons answer once;
  - Dismiss persists per device;
  - the notify toggle asks permission only on click and fires only while hidden;
  - no style attribute; zero CSP violations; desktop and phone.
- **Mutations** for each clearing path and each source filter.
