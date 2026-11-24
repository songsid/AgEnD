# Hub one-to-one: an agent messages its asker on its own (M-3638)

Status: approved on 2026-11-24; phase 1 implementation. The approved version has no hourly cap. Written 2026-11-24 against the dev tip `9f9c34dfd`.
Revised the same day on the owner's direction: follow the ClassicBot model, where an agent posts into the person's
chat whenever it has something. A short follow-up window is no longer the main option, and flooding is not a
concern for now.

## The problem

In a one-to-one chat with a shared agent, each question takes exactly one answer. The agent answers with
`report_result` on the Hub's correlation id; the Fleet marks that id used as it releases the answer
(`src/hub/representative.ts`, `report()`: "consume once"). A second report on the same id is not a Hub answer any
more.

An agent that answered "I'll prepare the data pack" and later wanted to add "the data pack is ready" was refused.
M-3637 makes that refusal say why. A ClassicBot in a Discord or Telegram chat has no such limit: it replies into
its chat whenever it has something. In a Hub group room an agent can also post again with `hub_room_post`. Only
the Hub one-to-one is limited to one answer.

## The model

**A one-to-one is a chat the agent can post into at any time, as long as the person may still ask it.** A question
is not needed first each time, and there is no window after an answer.

| Point | Choice |
|---|---|
| Where | Only a one-to-one that already exists: the person opened it and has asked this agent at least once. An agent cannot start a chat with someone who never asked it |
| When | Any time, while every check below holds |
| Content | Text and files, with an answer's size limits. Buttons and polls in phase 2 |
| Who sees it | Only that person |

### Consent and grant

Being allowed to ask an agent means agreeing to receive its messages in that one-to-one. There is no separate
opt-in prompt. The person can stop these messages in the one-to-one's "…" menu:

- **Mute this agent's own messages.** While on, the agent can still answer the person's questions, but a message
  it sends on its own is refused, and the agent is told the person turned them off. The person turns it back on
  in the same place. Refusing is chosen over delivering silently, so nothing piles up unseen.
Grant withdrawal or expiry can close the chat. There is no person-triggered Close action in phase 1.

Each message is checked at the moment it is sent, for exactly its text and files, like an answer. All must hold:

1. the agent is still shared, with the same consent (a backend or folder change ends it until shared again);
2. the person may still ask this agent now (Who may ask, a group, a team grant), and that grant has not expired;
3. the agent's sharing is not paused by its owner;
4. the person's account is active (not removed from the Hub) and the one-to-one is not closed;
5. the person has not muted the agent's own messages;
6. the sending agent process is the current one.

A failed check refuses the message and returns the reason to the agent in one sentence: not allowed any more,
paused, expired, the person has left, the chat is closed, the person turned messages off, or this Hub is too old.
Nothing is kept to send later: a message that appears after a pause is lifted or a grant is given back would
surprise both sides. A message already delivered stays in the chat.

Revoke, pause and expiry therefore stop messages at once, with no extra setting: the right to be asked and the
right to message are the same grant.

### What the person sees

- A new message from the agent at the bottom of the one-to-one, as an answer looks. In phase 1 it stands alone;
  quoting an earlier question comes in phase 2.
- It counts as unread and notifies exactly like an answer: the badge on the chat in the list, and whatever
  notification the person has for answers.
- The status line (M-3596) is unchanged. It shows working or queued only while a question has no answer. A
  message from the agent does not open it.
- The person's reply is an ordinary question to the agent.
- Offline or signed out: the message waits in the chat, unread.

### The agent's tool

**`hub_room_post` with the one-to-one as the room.** One tool, the same as for group rooms.

- `hub_room_list` also lists the agent's one-to-ones, marked as such and named by the person. The agent posts
  with the id.
- The result says "Delivered to <name>." or gives the refusal reason.
- The question prompt gains one sentence: the agent may write to this person again later with `hub_room_post`,
  and gives the one-to-one's id.
- A second `report_result` on an answered correlation id keeps M-3637's refusal, which now names `hub_room_post`
  and the id to use. Turning that second report into a message is left to phase 2: it needs answered ids kept
  with no end date, and one way in is simpler to explain and to test.

An agent already receives the asker's verified name with each question, so listing its one-to-ones shows it
nothing new.

### Duplicate loop guard

There is no hourly cap. A send is refused when both its text and its files' content digests equal the agent's
previous standalone message in that chat within a minute. Names are not compared. Same text with different files
is allowed; files-only messages with different contents are allowed. An idempotent retry returns the original result.

## Phases

**Phase 1 (aimed at size M).**

- `hub_room_post` into an existing one-to-one, text and files.
- `hub_room_list` lists the agent's one-to-ones.
- The six checks, with the reason returned to the agent.
- The message shows in the one-to-one, unread and notified like an answer.
- The person's mute in the "…" menu.
- The duplicate check, without an hourly cap.
- M-3637's refusal and the question prompt name `hub_room_post`.

**Phase 2.**

- A second `report_result` on an answered id becomes a message.
- Quoting a question (`receipt_id`), buttons and polls.


**Not planned.**

- An agent starting a chat with someone who never asked it.
- A "more is coming" state on the status line.

Phase 1 reuses the room-post adapter and transport, with separate direct-message storage. Mute stays in phase 1.

## For the builder to confirm before building

- Whether the Hub's journal and the receipt stages assume one agent message for a question, and what a message
  with no question needs.
- Which authorization the release uses: `phase: "release-answer"` is tied to a question's message id; a message
  with no question needs its own phase or the room-post path.
- Whether a one-to-one can go through the room-post machinery (`src/hub/member/room-post.ts`) or needs its own
  route beside the direct service.
- That the one-to-one view (`src/hub/rooms/direct-view.ts`) can show agent messages that belong to no question.
- That an older Hub refuses cleanly (a negotiated feature on the link).

## Phase 1 builder verification

1. **Journal and receipts.** Existing direct questions retain one answer and their current receipt stages. A standalone
   message is a separate `hub_direct_posts` row with an encrypted content reference anchored in its audit event.
   It does not fabricate a question, spend an answer, or create a working placeholder. Question and standalone rows
   share increasing room order; paging, unread/read state and SSE merge them for the person.
2. **Authorization.** No `release-answer` lease is reused. The room-post request uses its authenticated current
   member link, exact owned exposure, current per-send exposure/grant proof and active people. The final transaction
   rechecks publication/revision, pause, room state, permission expiry, mute and link currentness, binds staged files,
   writes the message and appends its audit. The member independently checks its current consent/incarnation before
   preparation, staging, sending and accepting the result. Existing Hub contact limits are unchanged.
3. **Reuse.** `HubRoomPostAdapter`, its encrypted operation journal, negotiated `room.post`, and existing attachment
   staging/downloads are reused. The Hub routes an explicit direct request to `HubDirectPosts`; group membership,
   automation depth/rate limits and group posts stay on their existing path. Direct rooms cannot satisfy the group
   post foreign key, so their standalone rows and mute/read state have separate additive tables.
4. **View.** A standalone message projects an ordinary agent bubble and files without `answerTo`, `replyTo` or
   pending status. It emits person-scoped `message.added` and `unread.changed`, exactly as a direct answer does.
   Offline messages remain unread. Mute is the shared checkbox menu item, saved for that chat; it does not block asks
   or their normal answers. No new Close action is introduced.
5. **Compatibility.** `direct-posts-v1` is negotiated on both ends; new fields/results are refused without it.
   The legacy hello retry removes it and preserves the 16-name offer. Old Hubs keep group-only behavior and a known
   direct room returns a plain too-old refusal. Signed question room ids are retained outside the strict question
   journal, bound to the exposure and lifecycle token, so a used-answer hint can identify the same chat after restart.
   Display-only post result text is omitted from the saved success result for older strict journal readers.

There is no reconnect/background replay. Only the same explicit operation can retry its frozen text/file identity;
changed paths/content or lifecycle are refused. A lost response remains uncertain and never asks the agent to use a
new operation id. Successful retries resolve to the existing message before the duplicate guard. The guard compares
text and the multiset of file content digests, including the previous ordinary answer, without an hourly cap.
