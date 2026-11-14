# Files in Hub group rooms (M-3125)

The user's first priority for Hub rooms (2026-11-15): Fleet-chat file parity in group rooms. Until now, every layer refused files: the post schema's `files` was capped at 0, the file routes knew only 1:1 rooms, posts had no link to files, the room ask and answer frames carried text only, and the room thread dropped `files`. The 1:1 chats (#3226) already have the whole path, and this reuses it.

## Slices

1. **People's files** (PR1a). Upload, post, list and read, plus the thread showing them. **PR1b** adds the composer's Attach button through web-claude's M-3117 `attach`/`pending` props: a group room's detail says `features: ["attachments-v1"]` when the Hub stores files; the page then offers Attach, uploads at once, shows chips inside the box, holds Send while a file uploads, and sends the ready ids as `files`. An older Hub (no feature) shows no Attach.
2. **Agents' files** (PR2). The new `room-files-v1` link feature: optional `attachments` on `room.ask` and `room.answer`, and on on-behalf posts once Ridge's `room.post` composes it. The member's `room-ask.ts` takes report_result `files`, and an ask's files reach the agent's inbox.
3. **Annotate → quote** on a room image (PR3). A room picture opens in the Fleet chat's own viewer, and 「標註」 quotes the marked-up copy in the room.
   - The viewer and editor (`image-lightbox.js`, `image-zoom.js`, `image-annotate.js`) move to `src/ui/shared/` and are served under `/assets/` by both listeners. Their old `/ui/js/` paths re-export them, as S-152 did for the message menu.
   - The viewer takes a Hub room picture only at its exact inline route, `^/hub/v1/rooms/<uuid>/files/<uuid>/inline$` (lower-case UUIDs, nothing after).
   - The room's one quote target, 「引用到這個房間」 / "Quote in this room", is offered only where the room takes files. It uploads the copy into the composer's files and sets the reply to the picture's message.
   - The Fleet chat's own targets are unchanged.

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

- Agents don't receive a person's files yet. An @agent post with files reaches the agent as text until `room-files-v1` (PR2).
- The room assistant stays text only.
