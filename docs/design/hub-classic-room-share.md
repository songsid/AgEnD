# Sharing ClassicBot rooms on the Hub (M-3014)

The user decided on 2026-11-13 (#3743 item 1, decision d1f29ab4) that ClassicBot rooms become shareable to the Hub, with
the same owner controls as Fleet agents. A room-only owner now sees 「這個 Fleet 還沒有可以分享的 Agent。」 and has no
next step.

This revision follows Ridge's review of the first draft
(https://github.com/songsid/AgEnD/pull/3765#issuecomment-6841085662).

- **The problem.** A room's CLI conversation is shared with its Discord or Telegram channel. If Hub questions went into
  that conversation, the private question and its answer would stay in the room's memory after the answer was sent. Any
  later channel reply could repeat them, and the Hub asker would get answers drawn from channel talk.
- **Why a guard is not enough.** A guard that refuses channel output only while a question is open cannot prevent that.
- **The design.** A shared room answers the Hub through a **Hub-only twin**: the room's settings and persona, its own
  session and folder, and no channel. This is option A, which the leader recommended; the user's choice is pending.

## What already holds

- **A room is a daemon with a stable local name.** Each ClassicBot room runs one daemon under
  `instanceName = classic-<name>-<last4 of channel id>[-<adapter id>]` (`src/instance-names.ts`), saved in
  `classicBot.yaml`, so it survives a channel rename.
- **The Hub never sees the local name.** An exposure on the wire is `{id, fleetId, owner, displayName, revision, state,
  dataViewId, allowedTools, policyDigest}` (`src/hub/protocol.ts`). The Hub keys it by uuid, stores `displayName` and an
  opaque digest, and judges `publish_agents` on the owner. **The Hub server, protocol and catalog do not change.**
- **The ask path is name-based.** `HubRepresentativeExecution` (`src/hub/representative.ts`) delivers to `local.agent`
  through `FleetManager.deliverHubQuestion`, and takes the answer from `report_result` to `agend-hub`, sent by the
  daemon of that name.
- **Rooms are shut out today only by four Fleet-side checks** that read `fleetConfig.instances`, which never contains
  rooms: the share list (`hubMemberAgents`), the lifecycle token (`hubAgentToken`), its incarnation inputs, and
  `deliverHubQuestion`.

## 1. Identity

| | The room | Its Hub twin |
|---|---|---|
| Name | `classic-…` (its `instanceName`) | `<room instanceName>--hub`. Name sanitizing collapses `-+`, so no room or instance can ever have this name. |
| On the Hub | the exposure's local agent: consent, `agentPolicyDigest(agent)`, the shown `displayName` | never named: an internal delivery target |
| Conversation | its channel's | its own: the Hub askers' only |
| Folder | `workspaces/<room>` | `workspaces/<room>--hub`: Hub attachments land in its own `inbox` and `hub-files` |
| Posts to | its channel | nowhere: it has no channel, adapter or topic, and answers only with `report_result` |

- **Consent stays on the room.** The owner shares "the room"; the twin is how it answers.
- **Lifecycle token.** The same `hubAgentToken` scheme on the room's name. The incarnation is the room's effective
  launch fields (backend, folder, runtime, machine) plus its credential profile and model, so a change to any of them
  invalidates earlier consent until the owner shares again (questions are held as `stale`, as for Fleet agents).
  - Removing the room (`/stop` unregisters it) drops the incarnation, stops the twin and removes its folder, so a later
    room with the same name never inherits the consent.

## 2. The twin

- **Settings: the room's, read at every start.** Backend, model, credential profile (`backendOptions`), display name and
  description from `classicBot.yaml`, plus the fleet defaults the room uses.
  - Not copied: `contextLines` and the collab/reply triggers (no chat log, no channel), and `webEcho`.
- **Persona: the room's instruction files only.** At each start, the twin's folder gets a fresh copy of the room
  folder's instruction files, if present: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.kiro/steering/*`.
  - Nothing else is copied: no `chat-logs`, saved images, inbox, git history or other files the channel may have
    produced.
- **On demand, auto-pause.** The twin is not running until the first Hub question. `deliverHubQuestion` starts or wakes
  it (ordinary delivery: idle gate, wake, retries). It pauses after the room's `auto_pause_after`, else 30 minutes.
- **Not a visible instance.** The twin isn't in fleet.yaml or classicBot.yaml. It is not listed in the dashboard's agent
  lists, chat, Fleet map or search, and no human or other instance can deliver to it. It counts toward the machine's
  agent limit like any daemon while it runs.
- **Restarts.** A room settings change from Settings restarts a running twin with the new settings. A plain room restart
  does not touch the twin.

## 3. The ask route

- The representative path is unchanged. `HubRepresentativeExecution` still delivers to `local.agent`, the room's name;
  the Fleet maps it:
  - `deliverHubQuestion(room)` delivers to the twin;
  - the twin's `report_result` to `agend-hub` reaches `service.report` with `caller` set to the room's name. The Fleet
    rewrites a twin caller to its room. This holds only for the twin's own daemon of the current room incarnation, never
    a same-name replacement: the room must still be registered and its token unchanged.
  - The pane-failure hook (`deliveryFailed`) and `files` (`inboxDir` / `scratchDir`) map the same way.
- **One conversation for all Hub askers**, as for Fleet agents: the twin's. The asker's existing note
  (`roomShared`: 「所有向這個 Agent 提問的人共用它的同一段對話…」) stays true.
- **Nothing crosses between the channel and the Hub.**
  - The channel never sees a Hub question or answer: different conversation, and the twin has no channel.
  - The Hub asker never gets channel talk: the twin has no chat log and no access to the room's folder.
  - So the first draft's in-flight reply guard and channel-message holding are not needed.
- **Defence in depth.** The twin has no channel, so the outbound handler already has nowhere to send its `reply`. It
  still refuses any channel-addressing tool from a `--hub` daemon with "answer with report_result to agend-hub", so a
  twin can never be pointed at a channel by a future routing change.

## 4. Publish rules and display

- **Who:** unchanged. The local admin switches the share on; the Settings confirmation runs as for agents; the Hub
  accepts it only if the owner may share (`publish_agents`).
- **List:** Settings → Hub → 「分享的 Agent」 lists rooms after the Fleet agents.
  - Each room row has a 「ClassicBot 房間」 / "ClassicBot room" tag.
  - Its share confirmation adds 「Hub 上的提問由這個房間的另一段對話回答，看不到頻道的內容，也不會出現在頻道裡。」 /
    "Hub questions are answered in a separate conversation of this room: it can't see the channel, and nothing appears
    there."
  - The interim line 「目前只能分享 Fleet 的 Agent，ClassicBot 房間還不能分享。」 (M-2988) is removed.
- **Limits:** rooms count toward the same 64-exposure limit (`exposures.ts`).
- **Refused and denied:** #3763's `hub_refused` row applies unchanged; also frozen and `delivery_unavailable`.
  - A room whose daemons would run natively on Windows is refused as a native Windows agent is.

## Build plan (after the user's choice)

**PR 1, Fleet side (`src/fleet-manager.ts`):**
- `hubAgentConfig(name)`: the fleet.yaml instance, else the room's effective config. The share list, token, quota,
  incarnation and delivery use it.
- the twin: its config from the room, the instruction-file seeding, on-demand start, auto-pause, hidden from every
  listing, stop and removal with the room;
- mapping the room to the twin for delivery, `report_result` (caller), `deliveryFailed` and files;
- the `--hub` outbound refusal.

**PR 1 tests:**
- a room is listed and publishes;
- a Hub question starts the twin, not the room;
- the room's channel conversation receives nothing;
- the twin's answer is released to the Hub;
- nothing reaches the channel adapter on any path: reply, react, edit_message, files;
- a later channel message is answered by the room, without the Hub text in its input;
- the twin's folder has the instruction files and none of `chat-logs` or inbox;
- a room backend change → questions held as `stale`;
- `/stop` → the twin is stopped and its folder removed, and a same-name room can't answer earlier consent;
- the twin is absent from instance lists and refuses human or instance delivery.

**PR 2, Settings words:** the room tag, the room share line, removal of the interim line, and before/after PNGs.

**Ridge reviews:**
- `src/hub/**` is unchanged, unless the caller mapping turns out to need a read in `representative.ts`; then Ridge
  reviews that.
- the twin's lifecycle and the report-caller mapping.

**Not in this change:** per-room permissions; the pause/resume of M-3015; letting the twin see channel context (the
point of this design is that it can't).

## Considered and set aside

- **One shared conversation with a channel-output guard (first draft).** It can't stop a released answer from
  surfacing in a later channel reply (Ridge).
- **A retained channel fence until a clean session.** The room would lose its channel context after every Hub question.
- **Accept and disclose.** It needs the user's explicit OK, and it is the weakest on privacy.
