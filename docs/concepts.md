# AgEnD concepts and definitions

Draft. Each term states what the code on main does today, verified against the
listed files. Anything inferred is marked. Role names follow the user's
definitions; where code and a decision disagree, see Mismatches at the end.

## fleet

The whole multi-agent system on one host: its instances, schedules, teams,
decisions and task board, driven by one daemon from one `fleet.yaml` in one
AgEnD home (`~/.agend`).

- Can: run agents reachable from chat connections, the web dashboard, or both.
- Can't: span hosts. There is one daemon, one fleet process, one home dir.
- Code: `src/fleet-manager.ts` (`FleetManager`), `src/config.ts` (`FleetConfig`).
- Refs: —

## instance / agent

One agent is one instance: a daemon driving one CLI in its own tmux pane, with
its own transcript, topic or room, and tool set. `instance` is the config and
runtime word (`fleet.yaml` `instances`); `agent` is the everyday word.

- Can: chat and call MCP tools within its tool set; message peers with
  `send_to_instance`, `delegate_task`, `report_result`.
- Can't: exceed its tool set, or touch another instance's state except through
  fleet tools (same-OS-user processes are not isolated from each other —
  see `docs/design/coordinator-tool-perms.zh-TW.md`).
- Code: `src/daemon.ts`, `src/instance-lifecycle.ts`.
- Refs: #804.

## General

The user's definition: AgEnD's administrator. General is the fleet's admin
instance — the first agent on a new fleet — and owns the General topic. An
instance runs under the `general` tool set when `general_topic: true` or its
name is `general`.

- Can (as of beta.8): everything in the `general` profile — full worker
  abilities plus `create/start/restart/wake_instance`, delegation, schedules,
  and the user's web-appearance settings (`src/tool-permissions.ts:107-136`).
- Can't (as of beta.8): the rest of the orchestration verbs —
  `delete/stop/pause/replace_instance`, teams, templates, fleet
  defaults/instance config, `migrate/reconcile_kiro_instance`,
  `update_decision`. Per the user's decision it is to receive all orchestration
  tools via an in-flight change; that change could not be located among the
  open PRs at draft time (marked unverified).
- Code: `src/tool-permissions.ts:107-136`, `:201-208`;
  `src/instance-lifecycle.ts:2741` (the General instance cannot be replaced).
- Refs: user decision 9e3bea6c (reference could not be resolved via
  `list_decisions` at draft time — see Mismatches).

## coordinator (role) vs `coordinator` tool set

Two different things. The role is the merge gatekeeper: only the coordinator
merges, by running `scripts/gate-merge.sh` when the parity reviewer's APPROVE
arrives; authors never run `gh pr merge`. The tool set is
`TOOL_PROFILES.coordinator = WORKER + ORCHESTRATION`: every worker ability plus
every verb that runs the fleet rather than does the work.

- The role can: merge reviewed PRs through the gate. It can't: approve —
  only the parity reviewer's APPROVE counts.
- The tool set can: create/delete/replace/start/stop/pause/wake/restart
  instances, manage teams and templates, edit fleet defaults and instance
  config, run kiro migration/reconciliation, change others' decisions and web
  settings (`src/tool-permissions.ts:80-98`).
- Code: `scripts/gate-merge.sh`, `src/tool-permissions.ts:100-107`.
- Refs: 62a2fffb (only the coordinator merges), e723a50a, 4e928ba6,
  `docs/design/coordinator-tool-perms.zh-TW.md` (zh-TW only).

## worker

An instance doing the work under the `worker` profile — the default when no
`tool_set` is written (`resolveToolSet`, `src/tool-permissions.ts:201-208`).

- Can: talk to people, report to peers (`send_to_instance`, `report_result`,
  `request_information`, `broadcast`, `delegate_task`, `delivery_status`),
  read fleet state, run its own task cards and schedules, keep its own theme
  and Office character.
- Can't: any orchestration verb. A refused call names the coordinator and
  suggests reporting back instead (`src/tool-permissions.ts:357-374`).
- Code: `src/tool-permissions.ts:33-78` (`WORKER`), `:185-208`.
- Refs: #804, #895 (own schedules only).

## team and team leader

A team is a named group of instances (`fleet.yaml` `teams`) for targeted
broadcasts and display grouping. There is no team-leader role in the code:
coordination sits with whoever delegates or dispatches the work.

- Can: address several instances at once; group the sidebar and Office.
- Can't: confer any authority — no leader election, no extra tools.
- Code: `create_team`, `list_teams`, `update_team`, `delete_team`
  (`src/channel/mcp-tools.ts`).
- Refs: see Mismatches.

## topic / General topic

A topic is the chat home of one instance: a Telegram forum topic (or the
equivalent scope on another connection) bound to it. The General topic is the
General instance's topic. Commands that belong to General answer "works in the
General topic" anywhere else.

- Can: reach exactly that instance by talking there.
- Can't: run General-only commands from another topic.
- Code: `src/topic-commands.ts`; `src/instance-lifecycle.ts:2257`;
  `src/tool-permissions.ts:207`.
- Refs: —

## Classic (ClassicBot) room

A private chat or group where ClassicBot runs a single agent, managed by
`classicBot.yaml` — separate from fleet topics, with its own admins
(`defaults.admin_users`) and chat allowlists.

- Can: `/start` an agent in the room and chat with it.
- Can't: use fleet-topic commands or see the fleet; an unregistered chat stays
  silent unless `/start` is allowed.
- Code: `src/classic-channel-manager.ts`.
- Refs: `docs/permissions.md`.

## web-only fleet

A fleet with no Discord or Telegram connection at all, used from the web
dashboard (user decision, 2026-11-01/02). Its agents run in topic mode, so they
can still message each other from the dashboard.

- Can: everything chat fleets do, through `/ui` instead of chat.
- Can't: chat ingress; `/web revoke` (there is no `/web`) — its Notice names
  the host's way, signing every browser out.
- Code: `src/web-only-fleet.ts:10-22`; `src/fleet-manager.ts:7807-7808`.
- Refs: 28c2d3a3.

## host owner / operator

The person on the AgEnD computer. On a web-only fleet, the `agend web --code`
session on this computer (`HOST_OPERATOR`): it confirms its own authority and
answers its own prompts.

- Can: confirm web authority, sign in, approve what asks for the host operator.
- Can't: act as operator from another machine, or after the session was
  revoked or ran out.
- Code: `src/authority/web-authority.ts` (`HOST_OPERATOR`);
  `src/fleet-manager.ts:2056-2060`; `src/locale.ts:1505-1506`.
- Refs: 28c2d3a3.

## fleet admin (`admin_users`)

A platform user id listed in a channel's `access.allowed_users` (fleet), or in
`defaults.admin_users` / `allowed_users` (ClassicBot). Admin is granted per
person, never per instance.

- Can: admin-gated commands, confirming sensitive changes, managing access.
- Can't: anything while unlisted — an empty list grants nobody, and open
  access or pairing approval alone does not grant the role
  (`docs/SECURITY.md:13`).
- Code: `src/config-validator.ts:368-376`, `:677`.
- Refs: —

## guest (web)

A person who is not a fleet admin, signed in on the dashboard with a guest
code (`web.guests`, #1920). Guests see only the agents they are granted, in
chat they could already use.

- Can: chat with granted agents; sign out with `/web revoke` (own sessions).
- Can't: admin routes, Notices, the usage report, or anything over surfaces
  the fleet closed to guests.
- Code: `src/config-validator.ts:738-740`.
- Refs: #1920.

## tool set / tool profile (`full`, `coordinator`, `general`, `worker`, `standard`, `minimal`)

The server-side table that decides which MCP tools an instance may call
(`TOOL_PROFILES`, `src/tool-permissions.ts:100-157`). An explicit `tool_set`
always wins; otherwise the General instance gets `general` and everything else
defaults to `worker` (`resolveToolSet`, `:201-208`).

- `full`: every tool. Set explicitly only; nothing resolves to it by default
  (the env-only fallback excepted, `:212-222`).
- `coordinator`: worker abilities plus all orchestration verbs — the profile
  for running the fleet.
- `general`: worker abilities plus a slice of orchestration
  (`create/start/restart/wake_instance`) and the user's web settings. Smaller
  than coordinator on purpose: a dispatcher has no business deleting instances
  or rewriting fleet defaults.
- `worker`: the default. Doing the work, with reporting (`report_result`)
  that `standard` lacks.
- `standard`: broad read access plus own schedules and themes, but no
  `report_result`, `delegate_task` or `request_information` — so it cannot
  complete the delegate → work → report protocol.
- `minimal`: a narrow sender — reply, forward, check delivery, read decisions,
  download, and see emoji/sticker listings.
- Code: `src/tool-permissions.ts:30-157`.
- Refs: #804.

## Needs you

The dashboard's `/ui/needs` queue plus the `needs_you` config: items parked
for a person — permission prompts, usage-limit holds, dialogs the agent must
not answer, unconfirmed deliveries.

- Can: be acknowledged per item.
- Can't: be answered by an agent on the person's behalf.
- Code: `src/config.ts:284-293`; `src/web-api.ts` (`/ui/needs/ack`);
  `src/daemon.ts:1564`, `:2071`, `:9888`.
- Refs: —

## Notices

On a web-only fleet, the Notices feed (`/ui/notices`) — what General would
have said in chat, kept, pushed and listed. Admins only, never a guest.

- Can: be listed and marked seen.
- Can't: be read by guests; on a chat fleet the feed is null because General
  says them.
- Code: `src/web-api.ts:2346-2349`; `src/fleet-manager.ts:7807-7808`.
- Refs: #2910 D2.

## delivery: ✅ 👀 ❌, "uncertain", queued hand-off (#3030)

A channel message's status reactions, driven by the delivering daemon:
⏳ queued (CLI busy, waiting), 👀 delivered (pasted + Enter, the agent has it),
✅ confirmed (processing observed, or a native queue hand-off succeeded),
❌ failed (window gone, retries exhausted). Cross-instance rows add two
states: `uncertain` — the evidence was inconclusive, so never resend and never
forward it as consent; and the queued hand-off (#3030) — a message handed to a
backend-native queue, watched in the transcript and settled ✅ when a turn
takes it, ❌ when it never does.

- Can: tell the sender, at a glance, how far a message got.
- Can't: prove permission. A receipt proves the CLI accepted the bytes, not
  that the person authorized the act — verify the human receipt before anything
  irreversible.
- Code: `src/daemon.ts:7907-7913`; `:2450-2545`; `docs/delivery-verification.md`.
- Refs: #3030, 7244b130, 954e5e96.

## schedule

A fleet timer: a cron line or a one-shot datetime that injects a message into
an instance (`create_schedule`, `list_schedules`, `update_schedule`,
`delete_schedule`). A non-coordinator's schedules may only target itself and
must be created by itself; acting on other instances' schedules takes the
`full`, `coordinator` or `general` profile.

- Can: wake an instance with a message on a timetable.
- Can't: reach beyond its scope — the target, not the tool, is the control.
- Code: `src/channel/mcp-tools.ts` (schedule tools);
  `src/tool-permissions.ts:67`, `:382`.
- Refs: #895.

## task board card

A unit of tracked work. Main tasks `M-n` are outcomes; sub tasks `S-n` are
steps under a main task. States: open, claimed, review, done, blocked,
cancelled. A main task that waits for the person's confirmation goes to
review; internal fleet cards are closed by their owner instead.

- Can: carry state, acceptance, comments and results across turns and
  instances.
- Can't: substitute for chat consensus — a blocked card still needs the person
  (or the dispatcher) to answer.
- Code: the `task` tool (`src/channel/mcp-tools.ts:79-80`).
- Refs: 1ea064ae (all dispatch goes on the board); the leader's team rule on
  internal cards (no decision id — leader instruction).

## decision

A recorded agreement (`post_decision`, `list_decisions`), scoped to a project
directory or to the whole fleet. Decisions are the fleet's memory of why, and
gates and reviewers cite them.

- Can: bind later behavior (a gate checks the cited decision's content).
- Can't: enforce itself — code that never reads a decision is not bound by it
  (see Mismatches).
- Code: `post_decision`, `list_decisions` tool definitions.
- Refs: dbcb1de2 (prune stale decisions on release).

## credential profile

A named credential set for one backend (`CREDENTIAL_HOMES`), so one fleet can
act under several accounts. `/login <backend> <profile>` signs a profile in;
chat sign-in from the fleet exists for some backends only.

- Can: separate accounts per instance or backend.
- Can't: share across backends — a profile belongs to its backend's home.
- Code: `src/backend/credential-profile.ts:5-13`, `:266-295`.
- Refs: —

## native Windows agent / paired PC / runtime

Today AgEnD runs on Linux and macOS (on Windows: under WSL, with desktop
shortcuts from `agend shortcuts`). A native Windows runtime is alpha work on
`release/2.3.5-alpha`, adapting the external #2934. Pairing (`agend access
pair`) is per-instance access codes for people — "paired PC" as a term is not
defined anywhere in code or docs.

- Can (alpha): run the agent natively on Windows once the alpha lands.
- Can't (today): run outside WSL on Windows.
- Code: `src/windows-shortcuts.ts`; `src/cli.ts:1241` (pairing mode);
  `docs/cli.md:394-398`.
- Refs: 72353fdf; see Mismatches.

## public link (quick vs named)

Temporary dashboard access for someone off the host. Quick: an auto-made
`trycloudflare.com` tunnel URL with a short TTL. Named: the operator's own
hostname, with a longer TTL. Guests may ride an open public link, but never
with authority.

- Can: show the dashboard (and, if switched on, search, the usage report,
  Office shares) without a chat account.
- Can't: admin surfaces that require the dashboard reached directly (guests,
  web authority, the dashboard's own web settings).
- Code: `src/config-validator.ts:424-429`;
  `src/office-share-service.ts:6` (quick-tunnel 429s);
  `src/public-preview.ts:4-5`.
- Refs: `docs/named-tunnel.md`.

## web session and the verified web go-ahead

A web session is a signed-in browser (dashboard reached directly, a LAN, a
tailnet, or opt-in over a link). A session carries the account's authority —
its messages read as `via web (verified)` — only after that account confirms
on Discord or Telegram (#1939); a guest session never qualifies. Agents check a
`web-verified` receipt like a Discord or Telegram message. A go-ahead action
(anything destructive, irreversible, spending, or authority-granting) needs a
Discord/Telegram receipt or a `web (verified)` one — an open browser alone
proves nothing.

- Can: with verification, stand behind the same acts as a chat message.
- Can't: without it, authorize anything; plain `via web` and guests never
  carry authority.
- Code: `src/authority/web-authority.ts`;
  `src/config-validator.ts:517-522` (`web.verified_authority`).
- Refs: #1939.

## Mismatches

Places where today's code and a decision (or the requested term) disagree.
Nothing here is papered over.

1. **Team leader.** The requested term has no counterpart: teams exist, but no
   leader role, election, or extra tool is defined anywhere in code or docs.
   Suggested reading: coordination sits with the delegating/dispatching
   instance.
2. **Paired PC.** The term is not defined in code or docs. The verified
   pieces: `agend access pair` pairing codes (`src/cli.ts:1241`) and the
   Windows runtime alpha (`release/2.3.5-alpha`, decision 72353fdf).
3. **General's orchestration tools.** Code's `general` profile
   (`src/tool-permissions.ts:107-136`) holds only
   `create/start/restart/wake_instance`, while the user's decision says
   General, as administrator, gets all orchestration tools via an in-flight
   change. No such open PR could be located at draft time — the code half is
   verified, the change half is not.
4. **Decision ref 9e3bea6c.** Not resolvable via `list_decisions` (titles,
   archived, tag filters) and not a commit in this clone. The General entry
   above cites it as given; the link stays unverified until the leader
   supplies the correct reference (asked via `request_information`,
   `cid-concepts-doc`).
5. **Administrator vs `allowed_users`.** The user defines General as the
   administrator, but the code grants admin per platform user id
   (`access.allowed_users`), not per instance — there is no instance-bound
   administrator identity. Pending the decision text in (4) for how the two
   are meant to meet.

[繁體中文](concepts.zh-TW.md)

