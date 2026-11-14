# Hub rooms: reactions, polls, message search (M-3127)

User priorities #3 and #4 (11-15). Group rooms today: no emoji reactions, `clickButton`/`vote` are inert stubs
(hub-room-thread.js), room answers refuse extras (member/room-ask.ts: "room answers currently support text only"),
and Ctrl+K only filters room names. This note is the server shape to agree with Ridge (protocol/compose owner) before
code. UI reuses the Fleet chat pieces (chat-render reactions/reply buttons/polls, the Fleet search dialog).

Out of scope: direct one-to-one agent chats (they already have buttons/polls via hub_answer_buttons; search over them
is a follow-up), people creating polls themselves (the Fleet chat has no such thing either), files.

## A. Reactions

**People.** One table, set semantics (no idempotency key needed: adding twice is a no-op).

```sql
-- component s3-room-reactions v1
CREATE TABLE hub_room_reactions (
  room_id TEXT NOT NULL REFERENCES hub_group_rooms(id), post_id TEXT NOT NULL REFERENCES hub_room_posts(id),
  member_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(post_id, member_id, emoji)
);
CREATE INDEX hub_room_reactions_room ON hub_room_reactions(room_id, post_id);
```

- `POST /hub/v1/rooms/:id/messages/:mid/reactions` `{ emoji, on: boolean }` → `{ reactions }` (csrf; person member;
  the post at or after my joined_sequence; archived → 409 `archived`; a system row → 409 `invalid`).
- `emoji`: one grapheme, `\p{Extended_Pictographic}` (with ZWJ/FE0F/skin tone), ≤ 16 UTF-16 units. Limits: 12
  distinct emoji per post (a 13th new one → 409 `limit`); a member's own rows per post ≤ 12.
- Projection (the same for every viewer): `RoomMessage.reactions?: { emoji: string; count: number; members: string[] }[]`
  — each emoji in the order of its oldest current row, its members (room member ids) oldest first. The page finds its
  own (`me.id`) and names the others from the room's members ("You, Bob and 3 others reacted with 👍"). Absent when none.
- Event: `message.updated` with the whole post (Ridge: the existing client already handles it; a dedicated event would
  need its own consumer), `sequence` = the post's. No event for a no-op. Visibility = `messages()` exactly, including
  M-3118's `hub_room_post_lineage.audience_sequence`.
- Removal of a member keeps their rows (history stays as it was), like their posts.

**Agents** (an agent's `react` on the room question it was asked — the Fleet chat's #2305 minimal reply).
- Capability `room-react-v1`; member → Hub frame `room.react` `{ messageId, roomId, exposureId, emoji }` where
  `messageId` is the room question delivered to that exposure. The Hub accepts it only for a delivery row of that
  exposure on that post (any state but `retired`/`expired`), and stores it with the agent's member id.
- Fleet side: room-ask.ts maps the agent's `react` tool on that delivery to the frame (today it has no path).
  One frame per emoji; the agent's later `react` replaces its own set on that post (Fleet semantics).

## B. Buttons and polls in group rooms

**Answer.** Room answers may carry the reply's buttons and poll (report_result `buttons` / `poll` to agend-hub),
under capability `room-answer-buttons-v1`: `roomAnswerSchema` gains `buttons?: HubAnswerButtons` (validated with
`validHubAnswerButtons`, the same model as direct chats). A member without the capability keeps refusing extras.

```sql
-- component s3-room-buttons v1
CREATE TABLE hub_room_buttons (
  post_id TEXT PRIMARY KEY REFERENCES hub_room_posts(id), room_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
  asker_member TEXT NOT NULL, content_ref TEXT NOT NULL, digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('buttons','poll')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','chosen','closed','expired')), revision INTEGER NOT NULL DEFAULT 1,
  chosen_index INTEGER, closed_at INTEGER, result_post TEXT
);
CREATE TABLE hub_room_votes (
  post_id TEXT NOT NULL REFERENCES hub_room_buttons(post_id), member_id TEXT NOT NULL, options TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY(post_id, member_id)
);
CREATE TABLE hub_room_button_operations (
  room_id TEXT NOT NULL, member_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL,
  PRIMARY KEY(room_id, member_id, idempotency_key)
);
```

- Labels, values and the poll question live in the content store (`content_ref`, encrypted like the post).
- **Plain buttons: the asker only** (the delivery's `asker_member`). `POST /hub/v1/rooms/:id/buttons`
  `{ messageId, index, revision, idempotencyKey }`; anyone else → 403 `not-asker` (the UI draws them disabled with
  "Only {asker} can answer"). The first click wins (`state=chosen`). The click becomes the asker's own room post —
  the button's **label** as text, `replyTo` the answer, mentioning that agent — so it is delivered through the normal
  room-ask path and shows in the room as the Fleet chat shows a click. Expiry: REPLY_BUTTON_TTL_MS, as direct chats.
- **Polls: every person member** (joined at or before the poll's post). Same route with `{ messageId, options: number[],
  revision, idempotencyKey }`; a later vote replaces the member's ballot until the poll closes (`seconds` elapsed, or
  the Hub's sweep). Single/multi, `reveal: close|live`, `showVoters` as the Fleet poll (reply-polls.ts).
- **Close**: one `system`-kind post `poll-closed` in the room (counts, as `pollResultsText`; names when showVoters),
  `replyTo` the poll; and that text is delivered to the asking agent as the poll's result (one delivery, same
  room-ask path; the Fleet chat's `[poll results]` message). `result_post` makes the close idempotent.
- Projection: `RoomMessage.buttons?: { id; labels; kind; state; revision; askerOnly: boolean; canAnswer: boolean;
  chosen?: number; poll?: { question; multi; reveal; closesAt; counts?: number[]; mine?: number[]; voters?: number } }`
  — counts only when `reveal=live` or closed. Event: `message.updated` with the post (per-viewer `mine`/`canAnswer`).
- Agents never vote; a button is data, never an approval (as buttons-v1).

## C. Message search (Ctrl+K)

- `GET /hub/v1/rooms/search?q=…&limit=20&cursor=…` → `{ hits: [{ roomId, roomName, messageId, sequence, at,
  author: {kind,name}, snippet }], cursor?: string }`.
- Scope: group rooms where I am a person member; posts at or after my joined_sequence; not `system`; answered rows
  only (`stage IS NULL OR stage='answered'`), the same visibility as `messages()`. Archived rooms included (they are
  readable). Newest first across rooms.
- Matching: q is 1–100 chars after trim (one CJK character is a word); every whitespace-separated word must appear; NFKC + case-folded substring on the decrypted text (content.get). **No
  plaintext index**: the content store is encrypted at rest and retention deletes content; an FTS table would copy
  plaintext out of both. Instead a bounded scan: at most 2000 posts read per request, newest first; if the budget runs
  out before `limit` hits, the answer carries `cursor` (the last scanned `(created_at, id)`), and the UI shows
  "Search older messages". A retention-removed row is skipped.
- `snippet`: up to 120 chars around the first hit, on grapheme boundaries; the client marks the match itself.
- One search per session at a time (`429 busy` otherwise); `limit` ≤ 50.
- **Jump**: the hit's room opens and the store pages older (`before`, 100 per page) until it holds `messageId`, then
  the thread's reveal() scrolls to it and flashes it (the Fleet search's jump). `sequence` lets the UI show "loading
  older messages…" honestly. No new paging route.

## Files

Server: rooms/schema.ts (2 migrations), new rooms/reactions.ts, rooms/buttons.ts, rooms/search.ts, rooms/service.ts
(projection + event), rooms/types.ts, http/compose.ts (3 routes), protocol.ts (`room.react`, answer `buttons`),
member/room-ask.ts (answer extras, react), rooms/agents.ts (answer intake).
UI: hub-room-thread.js (store), panel-hub.js (HubThread opts), shared/chat-render.js + shared/chat-thread.js (an
opt-in person reaction bar; the Fleet chat passes nothing and is unchanged), hub-switcher.js / search-dialog.js
(Ctrl+K message hits), hub-room-strings.js, shared/hub-rooms-u2.css.

## Order (alpha PRs)

1. People reactions (server + UI).
2. Agent buttons (asker only) and polls (everyone), agent reactions.
3. Ctrl+K message search + jump.
