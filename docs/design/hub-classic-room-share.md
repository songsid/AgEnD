# Sharing ClassicBot rooms on the Hub: Hub users join as verified guests (M-3014)

**Decisions.** The user decided on 2026-11-13 (decision b0e69ee4, refining #3743 item 1 / d1f29ab4): sharing a
ClassicBot room to the Hub means Hub users **join that room as guests**, in the same model as today's web guests (#1920,
`src/web-guest-access.ts`).

- **Everything in the room is shared.** Guests see the room's conversation, and what they write and what the agent
  answers is visible to everyone in the room, its Discord or Telegram channel included.
- **The split with Fleet agents.** Share a Fleet agent for private asks, isolated per person, as today. Share a room for
  joining the discussion.

This replaces the earlier twin and guard drafts of this note. Ridge's privacy finding on them no longer applies, because
nothing in a room is private.

## 1. Identity and scope

**Who.** The Hub's AD-verified person. That is the `PersonKey` (realm, objectId) the Hub already authenticates against
the directory, with the directory display name. Nothing in the guest's identity comes from Discord or Telegram.

**Where the scope comes from.**

| | Web guest today (#1920) | Hub guest (this design) |
|---|---|---|
| Account | the person's own Discord or Telegram account, signed in on the Fleet's dashboard | the Hub's AD person, signed in on the Hub |
| Scope (which rooms) | derived on every request from channel membership and the owner's saved access (`guestScope`) | the share's **join list**: the persons and AD groups the owner allows for that room, checked on the Hub at every read and post, and again on the Fleet |
| Rights | chat; never a command (`guestChatRefusal`, authority none) | the same: chat, never a command (`/…` and other admin text are refused) |
| What they see | the room's history as its channel showed it (`guestHistory`, `guestSeesMessage`) | the same projection, produced by the Fleet |

- **The join list.**
  - It reuses the exposure's existing grant rows (`/hub/v1/grants`, the owner's 「允許提問…」).
  - It is widened for rooms to an AD group, using the 「讓同仁加入」 group search; by-name search is #3743 item 3.
  - A grant may have an end date, as today.
- **Who may share.** Unchanged: the owner needs `publish_agents`. A refused share shows #3763's `hub_refused` row.
- **Fleet-side check.** The Fleet never trusts the Hub for scope alone. Each relayed post names the exposure and the
  person, and the Fleet checks that:
  - the exposure is a published room share;
  - the person's grant is not one it has seen revoked.

## 2. How the Hub user's message reaches the room and its channel

The Hub user's browser never reaches the Fleet. Everything goes over the existing member link, through new frames
(`room-share-v1`, negotiated in `hello` like the other features).

**Posting**
1. **The Hub UI sends the message.** `POST /hub/v1/rooms/shared/:exposureId/messages` with `{ text, idempotencyKey }`,
   with the session's CSRF check as today. The Hub checks the session, the join list, and that the person has seen the
   entry notice (section 3).
2. **The Hub relays it to the Fleet.** The Hub sends `room.post { exposureId, requestId, person: { realm, objectId,
   name }, text }` to the owner's Fleet and answers the browser once the Fleet acknowledges it with `room.posted`
   (`{ ok | refused: reason }`).
3. **The Fleet delivers it to the room** through the same entry as a channel message (`forwardToClassicInstance`'s
   delivery), with the room's own chat-log context:
   - the user is 「王小明（Hub）」, user id `hub:<realm>:<objectId>`, and `source: "hub"`;
   - the header the agent reads is `[user:王小明 via hub (company account verified), id:hub:…]`;
   - the authority is none, as for a web guest. A slash command or other admin text is refused with `guestChatRefusal`'s
     rule, before delivery.
4. **The channel sees it.** The Fleet posts it to the room's channel as 「王小明（Hub）：…」 through the same path as the
   room's web echo (`sendClassicWebEcho`). For a Hub post it is always on, whatever the room's `webEcho` setting: the
   room is shared, so its channel must see who is talking.
5. **The agent's answer** goes to the channel as it always does, with `reply`. Nothing is routed specially.

**Reading**
6. **The Fleet keeps no second copy.** The room's history is the Fleet's existing room history (`WebChatHistory`), which
   already records channel messages, web posts and the agent's replies.
7. **Opening a room.** The Hub asks with `room.read { exposureId, before?, limit }` and the Fleet answers with
   `room.page { entries, cursor }`. The entries are produced by the guest projection: what the channel showed, never
   owner-only rows, tool output or prompts.
8. **Live updates.** While at least one Hub user has the room open, the Hub sends `room.watch`, and the Fleet pushes
   `room.event { exposureId, entries }` as the history grows. `room.unwatch` stops it, and so does closing the link.
9. **What the Hub stores.** It does not store the room's transcript. It only relays it, so channel talk is not copied
   into the Hub database. The Hub's audit log records the joins (the notice accepted) and each post: the person, the
   time and the text, under the Hub's existing content retention.

**If the Fleet is offline**, the Hub page says the room can't be reached right now. Posts are refused, never queued.

## 3. The Hub UI entry point

- **Home / New chat:** shared Fleet agents stay under 「新對話」 (a private chat per asker, unchanged). Shared rooms get
  their own section, 「團隊房間」 / "Team rooms", each with its name, owner and a 「加入」 / "Join" button.
- **First join of each room:** a notice the person must accept before seeing anything:
  - zh: 「這是共用的團隊房間。房間裡的每個人，包括 Discord／Telegram 頻道裡的人，都看得到你說的話和 Agent 的回答。」
  - en: "This is a shared team room. Everyone in it — including the people in its Discord or Telegram channel — can see
    what you write and what the agent answers."
  - Accepting it is recorded in the Hub audit log. It is asked again if the notice text changes.
- **The room view:** the shared transcript with each speaker's name. Hub users are shown as 「名字（Hub）」; channel
  members by their platform name. A composer sits below, and a banner keeps the notice visible.
  - It differs from a private Fleet-agent chat: no per-asker isolation note, no "new chat", no stages per question.
- **Owner's side, 我分享的 Agent:** a room row is tagged 「ClassicBot 房間」. Its 「可以加入的人」 list takes persons and
  AD groups, where an agent's 「可以提問的人」 takes persons.
- **Fleet Settings → Hub → 分享的 Agent:** rooms are listed after Fleet agents, with the same switch and the room tag.
  - Switching a room on asks for the usual Settings confirmation, plus one line: 「分享後，Hub 上被允許的人可以加入這個房間的對話，頻道裡也看得到他們。」
  - The interim line 「ClassicBot 房間還不能分享」 (M-2988) is removed.

## Server contracts (Ridge's review, https://github.com/songsid/AgEnD/pull/3765#issuecomment-6842111937)

These four are pinned before any build. They override the looser wording above where the two differ.

**C1. Positive admission proof, never "not seen revoked".** Every `room.post` and every viewer's read carries a short-lived
Hub-authorized lease, built on the existing asker-envelope / authorization-lease pattern but with a scope of its own
(never a private agent's). Each lease is bound to:
- the authenticated member link (fleet, link epoch);
- the exposure id and revision (room generation);
- the verified person (realm, objectId);
- the grant that admits them (grant id and revision, or the group grant and the Hub's fresh membership check);
- for a post: the body digest and the browser's idempotency key;
- an expiry.

Ownership of the checks:
- **The Fleet** verifies the lease's signature and binding, that the room is still published at that revision, the link,
  and the expiry. It refuses an unknown, stale or expired lease. It never infers permission from the absence of a
  revocation, and it never claims to know AD group membership.
- **The Hub** owns the person's fresh authorization: grant, group membership, notice acceptance and session.

**C2. Watch ownership and disclosure fences.**
- **Subscriptions.** A watch is per viewer: subscription id and generation, person, exposure revision and lease. The
  Fleet-side `room.watch` is one aggregate per exposure. It answers only the room, publication and link check, and never
  authorizes a browser.
- **Before every disclosure** (each page, each event, each SSE write), the Hub re-checks that viewer's authorization:
  grant, group lease, session, notice. This is also done again after any awaited history or RPC result.
- **Group membership** is re-checked on a bounded lease (minutes), never cached indefinitely.
- **Bounds:** page size, frame and byte caps, pending events per viewer, and watches per person and per room.
- **Teardown** on disconnect, unwatch, expiry, grant, person or room revocation, and session loss. A reconnect or a
  reused room text or link id never revives an old subscription: it starts a new generation.
- **The notice acceptance** is bound to person + exposure + room generation + notice version. One viewer's acceptance
  never opens the room for another.

**C3. Durable posting identity and partial outcomes.**
- **Two identities.** The browser's idempotency key is the post's identity: kept separate from the transport `requestId`,
  carried to the Fleet in the lease, and bound to the person, exposure and body digest.
- **Durable recording.** The Fleet records the post in the existing durable input and delivery intent machinery
  (delivery outbox / input intent) before delivering, and the echo as its own durable step.
- **Partial outcomes.**
  - If `room.posted` is lost, a retry with the same key answers the recorded outcome and never delivers again.
  - If the Fleet reconnects after the guest's message was delivered, it answers "delivered".
  - If it crashes between the delivery and the channel echo, the echo runs on recovery, once.
  - When the result can't be proved, the answer is an explicit `uncertain`, never a refusal that invites a fresh
    duplicate.
- **Authority none** is pinned in the durable recovery path too, not only in the first header.
- **Bounded receipts and metadata** (key, person, time, outcome) are kept, although the Hub stores no transcript.

**C4. Group grants and real version skew.**
- **Grant model: M-3016's, the one canonical model (agreed with Cairn).** Room sharing adds no grant migration of its own.
  - Now public in #3781 (Cairn): `HubGrant.subject` is `{ kind: "person", person: PersonKey } | { kind: "group", group:
    PersonKey }`, and `subjectLabel` is presentation only. It adds one migration (`s3-grant-subjects`) and the fresh
    `grantAccess` / `exposureGrant` evaluator. New grants last at most 90 days. Room joins consume exactly these, once
    #3781 lands.
  - The grant subject keeps the existing tagged shape: `{ kind: "person", person: PersonKey }` or `{ kind: "group",
    group: { realm, objectId } }`, keyed by the immutable AD GUID (objectId) as in group policy.
  - No name or DN is authoritative. A group's label or DN is display data only, and a selection is re-resolved when it
    is saved.
  - M-3016 also owns the evaluator. It answers whether a person is admitted now, with session, generation and expiry
    fences and a bounded fresh membership check, never an indefinite cache. It also updates every authoritative reader:
    catalog, ask, read, delivery, and the policy impact inventory.
  - A room's join list is those grant rows, read through that evaluator. Whether agents also take group grants is
    M-3016's scope: the user's #3743 item 3 allows it.
  - Group grants are independent of roles (roles design 74a4129cd): team, usage or audit scopes give no right to join or
    ask.
- **Search is feedback only**, followed by the existing resolve, preview and current checks.
- **Skew.** An older peer's exposure schema is strict and rejects an unknown key, so:
  - an agent exposure never carries `kind`;
  - room exposures and every `room.*` frame are sent only when both ends negotiated `room-share-v1`;
  - against an older Hub, rooms are not shareable at all: the row says why, the same way as `delivery_unavailable`.

## 4. What changes where

**Fleet (`src/fleet-manager.ts`, the member compose):**
- the room-aware Hub agent helper (rooms listed and published, their lifecycle token);
- the `room.post` handler: the delivery as a Hub guest, the channel echo and the command refusal;
- `room.read` / `room.watch` with the guest projection.

**Hub (Ridge reviews):**
- **Protocol:**
  - `kind: "room"` on a room exposure only, never on an agent one (C4);
  - the `room.*` frames behind `room-share-v1`.
- **Catalog:** a room exposure is listed only to the people on its join list.
- **Routes:**
  - `/hub/v1/rooms/shared/:exposureId` (read and watch);
  - its `/messages` (post);
  - the notice acceptance;
  - grants extended to AD groups for room exposures.
- **Audit:** joins and posts.

**Not changed:**
- Fleet agents (the per-asker representative path);
- Hub sign-in (AD only, #3743 item 4).

**Not in this change:**
- files, buttons and reactions from Hub guests (text only first);
- Hub guests in a room's web dashboard (they stay on the Hub);
- the pause/resume of M-3015.

## 5. Tests (plan)

- **Posting:** a Hub person on the join list posts, and the room receives it as 「名字（Hub）」 with authority none. The
  channel gets the echo, and the agent's `reply` reaches both the channel and the Hub watchers.
- **Refusals:**
  - a person off the list, or whose grant is revoked or ended, is refused on the Hub and again on the Fleet;
  - a slash command is refused;
  - an unaccepted notice cannot post or read.
- **The projection:** what a Hub guest reads equals a web guest's for the same room; owner-only rows never appear.
- **Fleet offline:** reading or posting answers "can't be reached", and nothing is queued.
- **The Hub stores no transcript:** only audit rows.
- **Upgrade skew:** a Hub without `room-share-v1` never lists rooms. A Fleet without it rejects nothing it doesn't know
  (the exposure `kind` is optional).
