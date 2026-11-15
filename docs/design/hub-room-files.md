# Files in Hub group rooms (M-3125)

The user's first priority for Hub rooms (2026-11-15): Fleet-chat file parity in group rooms. Until now, every layer refused files: the post schema's `files` was capped at 0, the file routes knew only 1:1 rooms, posts had no link to files, the room ask and answer frames carried text only, and the room thread dropped `files`. The 1:1 chats (#3226) already have the whole path, and this reuses it.

## Slices

1. **People's files** (PR1a). Upload, post, list and read, plus the thread showing them. **PR1b** adds the composer's Attach button through web-claude's M-3117 `attach`/`pending` props: a group room's detail says `features: ["attachments-v1"]` when the Hub stores files; the page then offers Attach, uploads at once, shows chips inside the box, holds Send while a file uploads, and sends the ready ids as `files`. An older Hub (no feature) shows no Attach.
2. **Agents' files** (PR2). Room files on the link (negotiated as below): optional `attachments` on `room.ask` and `room.answer`, and on on-behalf posts once Ridge's `room.post` composes it. The member's `room-ask.ts` takes report_result `files`, and an ask's files reach the agent's inbox.
3. **Annotate → quote** on a room image (PR3). It reuses the Fleet chat's lightbox and annotate, with the Hub file URL accepted as an exact anchored pattern.

The HTML preview needs no slice of its own: the shared thread draws an `.html` attachment's preview card once a message carries it.

## Storage (no new table, no migration)

A group post's files are ordinary `hub_attachments` rows:
- `room_id` is the group room;
- `message_id` is the post id (a UUID, like a `hub_messages` id, so they never collide);
- `direction` is `question` for a person's file;
- `fleet_id` is NULL.

`HubAttachmentStore.bindPost` binds a member's pending uploads to the post in the post's transaction. `forMessage`, retention purge and orphan blob collection work unchanged. The 1:1 download still requires a `hub_rooms` room, so neither path can read the other's files.

## Routes

The 1:1 routes take a group room too. `compose.ts` sends a group room id to `HubGroupRooms`, which has the same three methods.

| Route | Who | Rule |
|---|---|---|
| `POST /hub/v1/rooms/:id/files` | a current member; the room is not archived | the same streaming, size, type and per-owner pending budget as 1:1; pending for one hour; audited `file.upload` |
| `POST /hub/v1/rooms/:id/messages` with `files` | the poster | up to 10 of the poster's own pending uploads in this room; a post may be files only; the idempotency digest covers the file ids |
| `GET /hub/v1/rooms/:id/files/:fid[/inline]` | a current member | **the listing's own visibility rule** (below), or the reader's own pending upload; audited `file.read`; served with nosniff, a sandbox CSP and no-store, inline for a checked image only |

**Visibility** is the rule the message listing uses (Ridge, M-3118). For a member whose floor is `joined_sequence`:
- the post's `sequence` is at or after the floor;
- its lineage `audience_sequence` (or its own sequence) is at or after the floor;
- the post it answers, if any, is too.

A chained answer posted after someone joined therefore doesn't reveal the files of a question they can't see, nor its own. For people's posts the lineage audience is the post itself. The clause matters for answers with files, so PR2 tests it.

## Not in PR1

- Agents don't receive a person's files yet. An @agent post with files reaches the agent as text until PR2.
- The room assistant stays text only.

## PR2: agents' files (room files on the link)

Room files have no link feature of their own (Fable #3925). Both hello lists are full: the member's is at the 16 names an older Hub accepts. So, like agent reactions, they ride on `room-answer-buttons-v1` plus `attachments-v1` (`roomFilesNegotiated` in protocol.ts).
- `room-answer-buttons-v1` is unreleased and ships in the same release as this PR, so every peer that lists it has this code.
- It must never be `room-ask-v1` + `attachments-v1`: released alpha Fleets list both, and their strict `room.ask` schema refuses `attachments`.
- **Release gate:** #3925 lands in the same release as #3935 (`room-answer-buttons-v1`). If a release ships that flag without this PR, a later Hub would send `attachments` to Fleets that refuse them.
- A Hub without an attachment store sends no files. A member without Hub file handling says the files are not available on this Fleet, and refuses an answer with files.

- **Ask.** The ask payload stored at enqueue names the asking post's files, in both directions: a person's upload or an agent answer's files on a chained ask. At send time the names are dropped for a link without the feature.
  - The asked fleet pulls the chunks with `attachment.get`. The group branch (`HubRoomAgents.attachmentGet`) serves only a fleet holding an open delivery of that exact post, re-checks that delivery's permission and validity at the read, and audits `file.transfer` once.
  - The member writes the files to the agent's inbox with the 1:1 representative's `HubMemberFiles.receive`, and names them in the prompt below the room data. A file that can't be fetched is named as missing; it never holds the question.
- **Answer.** `report_result` with `files` to agend-hub is accepted on a room ask; buttons and polls are still refused.
  - The files go through the reply rule (`HubMemberFiles.prepare`) and are staged with `attachment.put` before the frozen `room.answer` names them. That happens again on every resend, because staging expires.
  - The bytes must still match the frozen refs. Otherwise the answer stays unsent rather than naming other content.
  - A files-only answer is allowed.
  - The Hub binds the staged files to the answer post (`bindAnswer`) in the same audited transaction as the answer, and only when the answer is disclosed. An answer naming files from a link without the feature is refused (`incompatible`).
- **Read.** A member reads an answer's files under the same rule as people's posts, and only on an answered post. A member whose floor hides the question can't read the answer's files.

Not in PR2: on-behalf posts with files (Ridge's `room.post` stays text-only until a separate feature), and the room assistant.

