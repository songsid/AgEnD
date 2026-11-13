# Sharing ClassicBot rooms on the Hub (M-3014)

The user decided on 2026-11-13 (#3743 item 1, decision d1f29ab4) that ClassicBot rooms become shareable to the Hub, with
the same owner controls as Fleet agents. A room-only owner now sees 「這個 Fleet 還沒有可以分享的 Agent。」 and has no next
step. This note covers the room's identity on the Hub, the publish rules, the ask route into the room, and the refused
display. It ends with the build plan and what Ridge reviews.

## What already holds

A room is already most of the way to being an agent:

- **It is a daemon with a stable local name.** Each ClassicBot room runs one daemon (`startClassicInstance`) under
  `instanceName = classic-<name>-<last4 of channel id>[-<adapter id>]` (`src/instance-names.ts`). The name is saved in
  `classicBot.yaml`, so renaming the channel does not change it. Its working folder is
  `<agend home>/workspaces/<instanceName>`.
- **The Hub never sees the local name.** An exposure on the wire is `{id, fleetId, owner, displayName, revision, state,
  dataViewId, allowedTools, policyDigest}` (`src/hub/protocol.ts`). The Hub keys it by its uuid, stores `displayName` and
  an opaque digest, and judges `publish_agents` on the owner (`group-policy/resources.ts`, `admin-impact.ts`). Nothing on
  the Hub assumes a Fleet instance.
- **The ask path is name-based.** `HubRepresentativeExecution` (`src/hub/representative.ts`) delivers to `local.agent`
  through `FleetManager.deliverHubQuestion` → `deliverToInstance`, and takes the answer from `report_result` to
  `agend-hub` from the daemon of the same name. `deliverToInstance` already reaches room daemons; schedules use it the
  same way.

Rooms are shut out only by four Fleet-side checks that read `fleetConfig.instances`, which never contains rooms:

| Check | File | What rooms get today |
|---|---|---|
| `hubMemberAgents()` | `src/fleet-manager.ts` | not listed |
| `hubAgentToken()` | `src/fleet-manager.ts` | `null` → `provider-unavailable` |
| the incarnation fingerprint (the token's inputs; `writeHubIncarnations`) | `src/fleet-manager.ts` | read from fleet.yaml only |
| `deliverHubQuestion()` | `src/fleet-manager.ts` | refused (`false`) |

## 1. Identity

- **Local identity:** the room's `instanceName`. It is the `agent` in the consent, in `agentPolicyDigest(agent)`, and the
  delivery target. Nothing new is stored.
- **Shown name:** `shownInstanceName(instanceName)`, already room-aware: the room's `display_name`, else
  `classic: <channel name>`. It is the exposure's `displayName` on the Hub. The owner can rename it later, exactly as a
  Fleet agent's label.
- **Lifecycle token:** the same `hubAgentToken` scheme, `sha256("agend-hub-agent-v2", agent, incarnation)`. For a room,
  the incarnation is the room's effective launch config: backend, its working folder, runtime and machine. These are the
  same four fields as for a Fleet agent, read from the classic config.
  - Changing the room's backend or credential profile changes the token, so a share made under the old backend stops
    taking questions until the owner shares it again: questions are held as `stale`, exactly as for a Fleet agent whose
    launch config changed. (The row has no reason of its own for this today, for agents or rooms; out of scope here.)
  - Removing the room (`/stop` unregisters it) returns `null`, so no question is admitted.
  - A plain restart keeps the token.

## 2. Publish rules

- **Who:** unchanged. The local admin switches the share on; Settings confirms it (the same Settings confirmation as
  agents); the Hub accepts it only if the owner may share (`publish_agents`). There is no room-specific permission.
- **List:** Settings → Hub → 「分享的 Agent」 lists rooms after the Fleet agents.
  - Each room row carries a small 「ClassicBot 房間」 / "ClassicBot room" tag, so an owner with two similar names can tell
    them apart.
  - The lead's interim line "ClassicBot rooms can't be shared yet" (M-2988) is removed.
- **Limits:** rooms count toward the same 64-exposure limit as agents (`exposures.ts`).
- **Windows rooms:** a room whose daemon runs natively on Windows is refused for the same reason as a native Windows
  agent (`delivery_unavailable` / `agentDeliveryUnavailable`).

## 3. The ask route into the room

Delivery reuses the representative path unchanged: one conversation per shared agent. For a room, that is the room's own
CLI conversation, the same one its channel talks to. Two room-specific points follow.

### 3a. The answer must never go to the channel (guard)

A room's `reply` is always addressed to its registered channel: the fleet manager forces `chat_id`
(`docs/design/classic-reply-routing.md`). If a room answered a Hub question with `reply` instead of `report_result`, a
private Hub question's answer would be posted in the Discord or Telegram channel.

- **Rule:** while a room has a Hub question in flight, its `reply`, `react` and `edit_message` to the channel are refused
  with "answer the Hub question with report_result to agend-hub (correlation …)". "In flight" means a representative row
  that is dispatched but not yet released or failed.
- **Where:** `handleOutboundFromInstance` in `src/fleet-manager.ts`, the same place that already rewrites a room's
  address, asking the representative service `hasOpenQuestion(agent)`.
- **Scope:** only rooms. A Fleet agent's `reply` goes to its own topic, which is already the owner's.
- **What the room may still do:** reply to a later channel message, after the Hub question is answered or released.
- **Open for review:** if blocking every channel reply during a Hub question proves too strict, the alternative is to
  hold channel messages for the room until the question is answered. The guard is the smaller change, so it comes first.

### 3b. What the asker shares with the channel

As with any shared agent, all askers share the room's context. A room's context also includes what its channel said:
the platform path prepends `[Chat log for context]`, and the CLI remembers the conversation. A Hub question is delivered
without the chat-log prefix (the representative wrapper only), but the room can still answer from what it remembers.

- **Owner's share confirmation, for a room only:** 「Hub 上的人提問時，這個房間可能會用頻道裡談過的內容回答。」 / "When
  people ask on the Hub, this room may answer from what was said in its channel."
- **Asker's view:** unchanged. 「所有向這個 Agent 提問的人共用它的同一段對話…」 (`roomShared`) already says the
  conversation is shared.

## 4. Refused and denied display

#3763 applies as it is: the Hub refuses or accepts the whole snapshot, and a published row is marked `hub_refused` while
the last snapshot was refused. A room row reads 「未分享：Hub 管理員還沒有允許你分享 Agent。…」 with its switch off,
exactly like an agent row. The other row states also apply to rooms unchanged:

- frozen (「已在 Hub 停止分享」);
- `delivery_unavailable` (Windows).

## Build plan

Two PRs on the alpha line:

**PR 1 (Fleet side, `src/fleet-manager.ts` and the representative service):**
- one helper, `hubAgentConfig(name)`: the fleet.yaml instance, else the room's effective classic config, else null.
  - `hubMemberAgents()`, `hubAgentToken()`, the incarnation, quota and `deliverHubQuestion()` use it instead of reading
    `fleetConfig.instances` directly.
  - `observeHubAgentIncarnations()` keeps rooms.
- the reply guard (3a), with `hasOpenQuestion(agent)` on `HubRepresentativeExecution`;
- tests:
  - a room is listed, publishes, takes a question in its daemon, and answers with `report_result`;
  - a backend change → its questions held as `stale` until shared again;
  - `/stop` → refused;
  - a `reply` during an open question is refused and nothing reaches the channel adapter;
  - after release, `reply` works again.

**PR 2 (Settings words):**
- the room tag;
- the room-only confirmation line (3b);
- the interim "can't be shared yet" line removed (M-2988);
- before/after PNGs.

**Ridge's review.** The Hub server, protocol and catalog do not change. The touch points in `src/hub/**` are:
- `representative.ts`: one read-only `hasOpenQuestion(agent)`;
- `compose/member.ts`: passing it to the Fleet.

Ridge reviews those two and the guard's placement. Everything else is Fleet-side, reviewed by PR-number parity.

**Not in this change:**
- a separate Hub-only conversation per room (rejected for agents in `hub-representative-agent.md`, same reasoning);
- per-room permissions;
- the pause/resume of M-3015.
