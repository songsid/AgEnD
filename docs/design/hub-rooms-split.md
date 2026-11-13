# Hub rooms: work split and seams

For dispatch. English, because it is read by the builders. Product behaviour is in `hub-product-plan.md` (decided 2026-11-13, R1–R10); screens are in `hub-rooms-ux.md`. Pilot rule from the maintainer: features first, interfaces simple, no protocol or security design now. Hardening is on the pre-launch list.

Source read for this split: `release/2.3.5-alpha` @ `51b9f694`.

## 1. Who builds what

| Track | Owner | Builds | Starts after |
|---|---|---|---|
| **U** Hub chat UI | web-claude; dev-claude2 joins | The Hub's pages rebuilt from the Fleet chat's shared modules, every detail; rooms list, thread, composer with @, members rail | now (web-claude); P6/#3840 (dev-claude2) |
| **R** Rooms server | Ridge | Room model, membership, messages, @agent / @all routing, presence feed, unread, room permissions | the pilot trust button |
| **C** Consent and teams | Cairn | Agents entering rooms by owner consent; the Fleet side of a room ask; then virtual teams | #3824 |
| **A** Room assistant | Sentinel | One Hub-hosted instance per room, on the Hub owner's account, no tools, concurrency cap, admin page | now |
| **G** Hub General | later (R6) | Admin tools over the admin pages | rooms and teams admin pages exist |

Inside track U: web-claude owns the shell, list, thread and composer (the "copy the Fleet chat" part). dev-claude2 owns the dialogs and side pages: new room, room settings, members rail, invitations, 管理 → 房間.

## 2. The seams

Five seams. Each is a small, plain interface. If a builder needs a field that is not here, add it and tell the other side; do not wait for a review.

### Seam 1: rooms HTTP API (R provides, U consumes)

All under the existing Hub session and CSRF handling. Today's `/hub/v1/rooms` (one asker, one agent) stays and becomes `kind: "direct"`.

| Call | Purpose |
|---|---|
| `GET /hub/v1/rooms` | The list: `[{ id, kind: "direct" \| "group", name, people, agents, online, unread, lastAt, lastText, lastAuthor }]` |
| `POST /hub/v1/rooms` | Create a group room: `{ name, people: [personId], teams: [teamId], groups: [groupId], agents: [exposureId], assistant: boolean }` |
| `GET /hub/v1/rooms/:id` | `{ room, me: { role }, members: [Member], settings: { allMention, historyForNew } }` |
| `PATCH /hub/v1/rooms/:id` | `{ name?, allMention?, historyForNew?, assistant?, archived? }` |
| `POST /hub/v1/rooms/:id/members` / `DELETE …/members/:memberId` | Add or remove a person, team, group, own agent or the assistant |
| `GET /hub/v1/rooms/:id/messages?before=&limit=` | A page of `Message`, newest last |
| `POST /hub/v1/rooms/:id/messages` | `{ text, mentions: ["all" \| "assistant" \| exposureId], replyTo?, files?, idempotencyKey }` → the stored `Message` |
| `POST /hub/v1/rooms/:id/read` | `{ upTo: messageId }` |
| `GET /hub/v1/rooms/events` | One SSE stream for everything the person may see |

```
Member  = { id, kind: "person" | "agent" | "assistant" | "later", name, owner?: { name }, role: "manager" | "member",
            presence: "online" | "idle" | "working" | "paused" | "offline" | "later", presenceNote?: string }
Message = { id, roomId, at, author: { kind, id, name, owner? }, text, mentions, replyTo?, files?,
            ask?: { total, answered, working, later },          // on a message that @-ed agents
            answerTo?: messageId, stage?: "queued" | "working" | "answered" | "not-answered" }   // on an agent's reply
Events  = message.added | message.updated | presence.changed | room.changed | unread.changed | invitation.changed
```

Agreed with track U (2026-11-13):

```
files[]            = today's attachment { id, name, size, type, url }
Message            also carries idempotencyKey, echoed back, so the composer matches its optimistic row
message.added      { roomId, message }
message.updated    { roomId, message, parentAsk? }     // parentAsk: the @-message's new ask counts, when a reply changed them
presence.changed   { roomId, memberId, presence, presenceNote? }
member.changed     { roomId }                           // joined, left, role changed: the client refetches the room
unread.changed     { roomId, unread }
room.changed       { roomId, room } | { roomId, removed: true }   // removed: the person is no longer a member
invitation.changed {}
```

Until R lands, `hub-client` normalises today's `/hub/v1/rooms` answer into this shape (direct rooms, each entry as two Messages, unread 0), so the UI only ever sees the new model.

`kind: "later"` is a desktop-connector member (phase 4); the field exists now so the UI does not change later.

**So U does not wait for R:** web-claude writes a fixture that serves this API with canned data (a room with 3 people, 12 agents in every presence state, an @all with late answers, an assistant summary). U builds against the fixture; R replaces it. The fixture file is the contract's worked example.

### Seam 2: a room ask reaching a Fleet agent (R ↔ C)

A room ask is today's question with two extra fields, sent over the existing member link, answered through the existing answer path.

```
room.ask    Hub → Fleet   { messageId, roomId, roomName, exposureId, asker: { name }, text,
                            context: [{ author, text, at }]   // the last 30 room messages, oldest first
                          }
(answer)    Fleet → Hub   the existing answer frame, carrying messageId
agent.state Fleet → Hub   { exposureId, state: "idle" | "working" | "paused", note? }   // on change; offline = link down
```

- R owns the frames and the routing: `@agent` → one `room.ask`; `@all` → one per agent member; queue while the Fleet's link is down, deliver on reconnect, mark `not-answered` after 24 hours.
- C owns the Fleet side: deliver into the agent's own conversation with a header that names the room and the asker, include the context, send the answer back, and emit `agent.state` from the Fleet's existing instance states.
- A Fleet that does not know `room.ask` (older version) is shown as `offline` with the note 「需要更新 AgEnD」.

### Seam 3: agents entering a room (C provides; R and U consume)

| Call | Purpose |
|---|---|
| `POST /hub/v1/rooms/:id/invitations` | Room manager invites: `{ agents: [exposureId] }` or `{ team: teamId }` (every shared agent of its members) |
| `GET /hub/v1/invitations` | The owner's pending invitations: `[{ id, room: { id, name, people }, agent: { exposureId, name }, by: { name }, at }]` |
| `POST /hub/v1/invitations/:id/accept` / `…/decline` | The owner's answer. Accept calls R's `addAgentMember(roomId, exposureId)` |

An owner adding their own agent needs no invitation: it goes straight through seam 1's `POST …/members`.

### Seam 4: the room assistant (A provides; R consumes)

R treats the assistant as a member whose asks go to a local interface instead of a Fleet link.

```
interface RoomAssistant {
  available(): { enabled, backend, running, cap, state: "idle" | "busy" | "paused", note? }
  ask(input: { roomId, roomName, messageId, asker: { name }, text, context: [{ author, text, at }] }): Promise<{ text }>
  forget(roomId): void            // the room was archived or the assistant was removed
}
GET/PUT /hub/v1/admin/assistant   { enabled, backend, account, cap, idleMinutes }   + GET …/usage
```

- A owns how it runs: the Hub host's own AgEnD fleet, one ClassicBot-style instance per room keyed by the room id, started on the first ask (never resident), stopped after `idleMinutes` (default 15, range 1–240), at most `cap` running (default 3, range 1–16). Over the cap, asks queue in arrival order and the longest-idle instance is stopped to free a slot; one ask at a time per room. Its conversation survives idle stops; `forget(roomId)` drops it.
- Backend and account: one for all rooms, set by the Hub admin; the account is a credential profile of the fleet on the Hub host. Not signed in or out of quota: `state: "paused"` with a note.
- No tools, no files. Its account and quota are the Hub owner's.
- A person's 1:1 with 「Hub 助理」 is a direct room whose only agent is the assistant; the same `ask` serves it.
- Until A lands, R ships with `available().enabled === false` and the UI hides the assistant.

### Seam 5: teams and permissions (C and R provide; U consumes)

```
GET/POST /hub/v1/teams, GET/PATCH/DELETE /hub/v1/teams/:id     Team = { id, name, department: groupId, lead: personId, members: [personId] }
GET/PUT  /hub/v1/admin/rooms/creators                           { people: [personId], teams: [teamId] }   // who may create rooms besides the admin
GET      /hub/v1/admin/rooms                                    names and members of all rooms, no content
```

- Teams (C): a subject of kind `team` is accepted wherever a person or AD group is today: room members, invitations, and owner ask grants. C adds it next to the existing `person | group` subject.
- Room permissions (R): creator check on `POST /rooms`; `manager | member` on every room call; `allMention` checked on `POST …/messages`.

## 3. Files, so nobody edits the same one

| Area | Owner | Notes |
|---|---|---|
| `src/ui/panel-hub.js` (shell), new `src/ui/hub-room-list.js`, `hub-room-thread.js`, `hub-room-composer.js`; changes to `src/ui/shared/chat-*.js` | web-claude | Shared modules stay shared: the Fleet chat must not change visibly |
| new `src/ui/hub-room-new.js`, `hub-room-settings.js`, `hub-room-members.js`, `hub-invitations.js`, `hub-admin-rooms.js` | dev-claude2 | Each with its own strings module |
| `src/ui/hub-client.js` | web-claude | The seam 1, 3, 5 methods are added in one first PR, so others only call them |
| new `src/hub/rooms/` (the existing `src/hub/rooms.ts` moves in as the direct kind) | Ridge | |
| `src/hub/protocol.ts`, `src/hub/http/compose.ts` | Ridge | Others ask Ridge for a frame or route line; Ridge adds it the same day |
| new `src/hub/invitations.ts`, `src/hub/teams/`, `src/hub/member/room-ask.ts` | Cairn | |
| new `src/hub/assistant/`, and the Hub host fleet wiring | Sentinel | |

Rules for all tracks: new strings in their own module and namespace (an older cached tab must still load); zh-TW and English together; the vocabulary in `hub-rooms-ux.md` section 1; update `src/general-knowledge/skills/hub/SKILL.md` in the PR that changes what a user sees.

## 4. Order

| Step | U | R | C | A |
|---|---|---|---|---|
| 1 | `hub-client` methods + fixture; shell and list on the Fleet chat modules | room model, membership, people-only messages, SSE | Fleet side of `room.ask` against a stub Hub | assistant instance lifecycle on the Hub host, `ask()` returning text |
| 2 | thread, composer with @ menu, members rail with presence | @agent and @all routing, queueing, `agent.state`, unread | invitations and consent | admin page, cap and idle stop, usage |
| 3 | new room, settings, invitations, 管理 → 房間 | permissions, creators, admin list; swap the fixture for the real API | teams; `team` subject everywhere | plugged into R through seam 4 |
| 4 | one end-to-end walk on a rig by Lumen; fixes | | | |

Steps 1 and 2 need no cross-track merge order: every track has a stub for the other side.

## 5. Not in this phase

Hub General, the desktop MCP endpoint and reply-later members, the channel bridge to Discord or Telegram, file attachments from agents, the daily-report tutorial, roles, and everything on the pre-launch hardening list in `hub-product-plan.md`.
