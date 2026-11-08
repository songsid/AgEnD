# AgEnD concepts and definitions

Draft. Each term states what the code on main does today, verified against the
listed files. Anything inferred is marked. These definitions were approved by the project
owner; behaviour that differs from them is a bug or needs a decision.
Where code and a decision disagree, see Mismatches at the end. Fleet decisions are scoped to the leader's project root and cannot be
opened by readers, so each citation carries its user-facing summary inline.

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

The user's definition (fleet decision 9e3bea6c, "General is the AgEnD
administrator", user 2026-11-04): as of beta.8 the `general` tool profile gets
the full ORCHESTRATION set — instance create, delete, replace, start, stop,
pause, wake and restart; templates; teams; `update_fleet_defaults`;
`update_instance_config`; the kiro migrate and reconcile tools;
`update_decision`; web settings — with no extra confirmation. The existing
confirmations stay: sensitive config (tokens and access) is confirmed by a
fleet admin, and #804 still refuses `tool_set` or `skipPermissions` escalation.
It supersedes the 2026-09-21 "dispatcher" rationale and lands in beta.8 (agy's
PR). General is the fleet's admin instance — the first agent on a new fleet —
and owns the General topic. An instance runs under the `general` tool set when
`general_topic: true` or its name is `general`.

- Can (as of beta.8): everything in the worker profile plus the full
  ORCHESTRATION set, delegation, schedules, and the user's web-appearance
  settings.
- Can't: exceed that set. Note the code on main is pre-beta.8 and still shows
  the smaller subset (`src/tool-permissions.ts:107-136` holds only
  `create/start/restart/wake_instance` plus the web settings
  (`get/set_web_settings`) of the orchestration verbs) — expected
  to change when beta.8 lands; see Mismatches.
- Code: `src/tool-permissions.ts:107-136`, `:201-208`;
  `src/instance-lifecycle.ts:2741` (the General instance cannot be replaced).
- Refs: fleet decision 9e3bea6c.

## `coordinator` tool set

`TOOL_PROFILES.coordinator = WORKER + ORCHESTRATION`: every worker ability plus
every verb that runs the fleet rather than does the work — for an agent that
runs part of the fleet.

- Can: create/delete/replace/start/stop/pause/wake/restart instances, manage
  teams and templates, edit fleet defaults and instance config, run kiro
  migration/reconciliation, change others' decisions and web settings
  (`src/tool-permissions.ts:80-93`).
- Can't: exceed the table — anything not listed is refused, with the reason
  naming what the instance runs under.
- Code: `src/tool-permissions.ts:100-107`.
- Refs: `docs/design/coordinator-tool-perms.zh-TW.md` (zh-TW only).

## worker

An instance doing the work under the `worker` profile — the default when no
`tool_set` is written (`resolveToolSet`, `src/tool-permissions.ts:201-208`).

- Can: talk to people, report to peers (`send_to_instance`, `report_result`,
  `request_information`, `broadcast`, `delegate_task`, `delivery_status`),
  read fleet state, run its own task cards and schedules, keep its own theme
  and Office character.
- Can't: any orchestration verb. A refused call names the coordinator and
  suggests reporting back instead (`src/tool-permissions.ts:357-374`).
- Code: `src/tool-permissions.ts:33-72` (`WORKER`), `:185-208`.
- Refs: #804, #895 (own schedules only).

## team and team leader

A team is a named group of instances (`fleet.yaml` `teams`) for targeted
broadcasts and display grouping. A team leader is an instance that runs a
team, given the `coordinator` (or `full`) tool set — a convention, not a
separate role in code (approved by the user 2026-11-04).

- Can: address several instances at once; group the sidebar and Office.
- Can't: confer any authority — no leader election, no extra tools.
- Code: `create_team`, `list_teams`, `update_team`, `delete_team`
  (`src/channel/mcp-tools.ts`).
- Refs: —

## topic / General topic

A topic is the chat home of one instance: a Telegram forum topic (or the
equivalent scope on another connection) bound to it. The General topic is the
General instance's topic. Commands that belong to General answer "works in the
General topic" anywhere else.

- Can: reach exactly that instance by talking there.
- Can't: run General-only commands from another topic.
- Code: `src/topic-commands.ts:836-839` (a General command typed in an
  instance topic points to General, never to that agent);
  `src/locale.ts:880` ("works in the General topic");
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
answers its own prompts. The browser signed in from outside with the
authenticator's TOTP code (see "connections from outside") is the verified
owner too, with the same authority, checked on every request.

- Can: confirm web authority, sign in, approve what asks for the host operator.
  On a web-only fleet the verified owner — on this computer, or signed in from
  outside with the authenticator — can also approve a new device
  (device-code sign-in) and sign other devices out.
- Can't: act as operator from another machine, except the owner signed in from
  outside with the authenticator; or after the session was revoked or ran out.
  Setting up, re-binding or removing the authenticator is this computer only.
- Threat model (64a289a0): a process running as the fleet's OS user is
  treated as the owner. It can read `web.token` and mint this session, and it
  can edit `fleet.yaml` anyway. AgEnD defends against remote parties, other OS
  users, links, guests and CSRF; see `docs/SECURITY.md#threat-model`.
- Confirming a held Settings change on a web-only fleet (alpha.7, the user's
  decision hmsg-468cc290; threat model 64a289a0): the host operator's own
  session on this computer (its host session, a loopback request with no
  forwarding header) confirms with Apply now, including the Hub changes that
  open the fleet outward (pairing, publishing an agent, the browser
  certificate). Any other admin session on this computer or the LAN confirms
  with a fresh authenticator code. The code is the authority, bound to that one
  change, used once, under the same wrong-code limit as signing in from
  outside, and audited as "Authenticator code". Never over a link (named or
  quick): there the page says to confirm on the host computer's own browser,
  or in General. On a chat-connected fleet the primary General's card decides.
- Code: `src/authority/web-authority.ts` (`HOST_OPERATOR`, `hostSessionHere`);
  `src/fleet-manager.ts:2056-2060`; `src/locale.ts:1505-1506`;
  `src/fleet-manager.ts` (`settingsTotpSession`, `settingsTotpConfirm`).
- Refs: 28c2d3a3, 64a289a0, #3165, #3327, #3352.

## fleet admin (`admin_users`)

A platform user id listed in a channel's `access.allowed_users` (fleet), or in
`defaults.admin_users` / `allowed_users` (ClassicBot). Admin is granted per
person, never per instance. Fleet admin = the people; General = the
administrator agent that carries out admin work for whoever may talk to it in
the General topic (approved by the user 2026-11-04).

- Can: admin-gated commands, confirming sensitive changes, managing access.
- Can't: anything while unlisted — an empty list grants nobody, and open
  access or a saved chat grant alone does not grant the role
  (`docs/SECURITY.md:13`).
- Code: `src/config-validator.ts:368-376`, `:677`.
- Refs: —

## guest (web)

A person who is not a fleet admin, signed in on the dashboard with a guest
code (`web.guests`, #1920). Guests see only the agents they are granted, in
chat they could already use.

- Can: chat with granted agents; sign out with `/web revoke` (own sessions).
  A Trusted guest (#2855) also gets a read-only View of those agents — for
  Claude Code with its earlier conversation, tool results included, like
  anyone who may open the View (#3069).
- Can't: admin routes, Notices, the usage report, or anything over surfaces
  the fleet closed to guests.
- Code: `src/config-validator.ts:738-740`.
- Refs: #1920.

## tool set / tool profile (`full`, `coordinator`, `general`, `worker`, `standard`, `minimal`)

The server-side table that decides which MCP tools an instance may call
(`TOOL_PROFILES`, `src/tool-permissions.ts:103-155`). `defaults.tool_set`
applies to every instance without its own value, including General; an
explicit `tool_set` always wins, otherwise the General instance gets `general`
and everything else defaults to `worker` (`resolveToolSet`, `:201-208`).

- `full`: every tool. Set explicitly only; nothing resolves to it by default
  (the env-only fallback excepted, `:212-222`).
- `coordinator`: worker abilities plus all orchestration verbs — the profile
  for running the fleet.
- `general`: General's administrator profile — as of beta.8, worker plus
  every orchestration verb (fleet decision 9e3bea6c); before beta.8 only
  `create/start/restart/wake_instance` — and the user's web settings.
- `worker`: the default. Doing the work, with reporting (`report_result`)
  that `standard` lacks.
- `standard`: broad read access plus own schedules and themes, but no
  `report_result`, `delegate_task` or `request_information` — so it cannot
  complete the delegate → work → report protocol.
- `minimal`: a narrow sender — reply, forward, check delivery, read decisions,
  download, and see emoji/sticker listings.
- Code: `src/tool-permissions.ts:30-155`.
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
cancelled. A main task that waits for someone's confirmation goes to review;
finishing it from review with done.

- Can: carry state, acceptance, comments and results across turns and
  instances.
- Can't: substitute for chat consensus — a blocked card still needs the person
  (or the dispatcher) to answer.
- Roles, projects (#3195; the user's decision 9af8d799, 2026-11-06): an agent
  may create a project (`create_project`: name, description) and move a main
  task into, between or out of projects by the project's id (`update` with
  `project`, or `move_project` for several, each card on its own) when it may
  edit that card: unassigned, assigned to it, created by it, or dispatched by
  it. Archived projects are refused; a sub task follows its main task and
  never moves alone. A project's lead, renaming and archiving stay a person's,
  and a person may do all of it. Before this, creating projects and moving a
  main task between them were a person's only.
- Code: the `task` tool (`src/channel/mcp-tools.ts:79-80`).
- Refs: —

## decision

A recorded agreement (`post_decision`, `list_decisions`). Decisions are the
fleet's memory of why, readable with `list_decisions`. Each one has a scope:

- **team**: every member of one team (fleet.yaml `teams`), wherever they work.
  Membership is read when listing and at each launch, so joining or leaving a
  team takes effect without posting again. This is the default for a poster in
  a team; a poster in several teams names one.
- **project**: this exact working directory only. This is the default for a
  poster in no team.
- **fleet**: every instance on the fleet. Use it only for rules every team
  follows.

An instance's Active Decisions are the fleet ones, its teams' ones and its own
directory's ones.

- Can: record agreements agents and people consult later.
- Can't: enforce itself — code that never reads a decision is not bound by it
  (see Mismatches).
- Code: `post_decision`, `list_decisions` tool definitions.
- Refs: —

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
shortcuts from `agend shortcuts`). The rest is alpha only
(`origin/release/2.3.5-alpha`, adapting the external #2934 — decision
72353fdf).

- A native Windows agent uses this PC's Windows-side CLI: AgEnD in WSL
  discovers native Windows CLIs and runs Windows agents in the same fleet
  registry as Linux agents (`runtimes.windows_cli`, off by default).
- A paired PC is another Windows computer connected over HTTPS: it runs the
  small `agend-runtime` runner (installed from Settings with a one-line
  PowerShell command that checks the script's SHA-256 first, or from a ZIP;
  never a fleet), connects outbound with a one-time pairing code, and joins
  only after its pairing fingerprint is approved in Settings (#2936). Agents
  pinned to it keep their working directories on that PC.
- General can run on a Windows pane: "Run General on" moves General to an
  approved, online paired PC while the coordinator — and chat and
  administrator authority — stay on the host (#3007).
- People are allowed through **Settings → Chat & connections → Chat connections → the bot → Allowed users (primary bot)**, not runtime pairing. Legacy people-access codes are removed;
  existing saved grants remain. This does not grant fleet-admin authority.
- Code (alpha branch): `docs/remote-runtime.md`, `docs/windows-cli-preview.md`,
  `docs/windows-general.md`; `src/runtime-bundle.ts`.
- Refs: 72353fdf, #2936, #3007.

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

## connections from outside (alpha only)

`origin/release/2.3.5-alpha`: a web-only fleet may open itself to the
internet — "Allow connections from outside" — and sign the outside browser in
with an authenticator-app TOTP code (#3008; fleet decision 0471da59). While
that switch is on and "Only this computer can authorize" is off, the browser
signed in this way is the verified owner, the same as the host operator.

- Can (alpha): reach the dashboard from outside without a tunnel the operator
  builds; sign in with the authenticator app's code and, as the verified owner,
  approve a new device and sign other devices out (maintainer ruling, #3165).
- Can't: use it on main today — alpha only; set up, re-bind or remove the
  authenticator (this computer only).
- Code (alpha branch): `src/auth-api.ts` (`/auth/totp`);
  `src/authority/web-authority.ts`; `src/fleet-manager.ts` (`deviceApprovalOwner`).
- Refs: #3008, #3165, fleet decision 0471da59.

## web session and the verified web go-ahead

A web session is a signed-in browser (dashboard reached directly, a LAN, a
tailnet, or opt-in over a link). A session carries the account's authority —
its messages read as `via web (verified)` — only after that account confirms
on Discord or Telegram (#1939); a guest session never qualifies. Agents check a
`web-verified` receipt like a Discord or Telegram message. A go-ahead action
(anything destructive, irreversible, spending, or authority-granting) needs a
Discord/Telegram receipt or a `web (verified)` one — an open browser alone
proves nothing.

Device-code sign-in (alpha experiment): on a web-only fleet with web
authorization on, a new device shows an 8-character code and the verified owner
approves it from a signed-in device. The session it gets is an ordinary one —
plain `via web`, never the approver's owner authority. On a web-only fleet only
the verified owner may end another session.

- Can: with verification, stand behind the same acts as a chat message; sign
  itself out. The verified owner can also approve a new device and end another
  session.
- Can't: without verification, authorize anything; plain `via web` and guests
  never carry authority. A session made by a device approval (or any other
  non-owner session) cannot approve a device or end another session, only its
  own. Device-code sign-in is not offered on a fleet with a chat connection, or
  while web authorization is off.
- Code: `src/authority/web-authority.ts`;
  `src/config-validator.ts:517-522` (`web.verified_authority`);
  `src/fleet-manager.ts` (`deviceApprovalOwner`, `mayEndOtherSessions`).
- Refs: #1939, #3165.

## Mismatches

Real code-vs-decision gaps only. Nothing here is papered over.

1. **General's orchestration tools (temporal, expected to resolve).** Code on
   main is pre-beta.8: the `general` profile
   (`src/tool-permissions.ts:107-136`) holds only
   `create/start/restart/wake_instance` plus the web settings. Fleet decision
   9e3bea6c moves it to
   the full ORCHESTRATION set in beta.8 (agy's PR). No live mismatch once beta.8
   lands; until then the code half is verified and the change half is the
   decision's word.

[繁體中文](concepts.zh-TW.md)

