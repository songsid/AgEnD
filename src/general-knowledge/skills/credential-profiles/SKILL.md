---
name: credential-profiles
description: Run agents on more than one subscription of the same backend. Use when someone asks for a worker on a different account, wants an agent moved to another subscription, or asks which subscription an agent is using. Currently kiro-cli, codex and claude-code.
roles: [general]
---

# Credential Profiles

One AgEnD fleet normally shares one login per backend. A **credential profile**
is a named, separate login for the same backend, so two agents can run on two
subscriptions at once.

`kiro-cli`, `codex` and `claude-code` have profiles today. For any other backend,
say so rather than setting an option that will be ignored.

**The two behave differently when you switch, and it is not a setting.** Kiro
keeps its conversations inside the same database as its login, so a different
subscription is a different set of them: switching is a new conversation. Codex
keeps its login in one file beside conversation stores that carry no account, so
switching leaves the history where it is and both subscriptions see it. Claude
Code behaves like Kiro: the profile is its whole config directory, conversations
included, so switching is a new conversation. Say which one you are talking
about.

## Is a profile already set up?

A profile exists once someone has logged into it on the host. AgEnD cannot log
in for them: the login is a browser device flow.

**A switch to a profile that has never been logged in is refused**, and the
error carries the exact command to run. This is deliberate: kiro-cli does not
start a signed-out session, it stops at "let's get you signed in!" and waits for
a keypress, so the agent would sit on a login screen instead of working. Relay
the command, do not try to work around the refusal.

Ask the operator to run this on the host once per subscription:

```
XDG_DATA_HOME="${AGEND_HOME:-$HOME/.agend}/credential-profiles/kiro-cli/<profile>" kiro-cli login
```

For codex the variable and the path are different:

```
CODEX_HOME="${AGEND_HOME:-$HOME/.agend}/credential-profiles/codex/<profile>" codex login
```

For claude-code a fleet admin can do it **from chat**, no host access needed:

```
/login claude-code <profile>
```

It opens the same browser-terminal login as `/login claude-code`, for that
profile only. Or on the host:

```
CLAUDE_CONFIG_DIR="${AGEND_HOME:-$HOME/.agend}/credential-profiles/claude-code/<profile>" claude auth login
```

Kiro and codex profiles cannot be signed in from chat yet: `/login kiro-cli <profile>`
answers with the host command to run.

A Claude Code profile keeps its own login, trust and conversations, and a
`settings.json` that starts as a copy of the user's; the user's `CLAUDE.md`,
agents, commands, skills, output styles and plugins are shared with it.

**When a switch was refused, relay the command from the refusal, character for
character** — never one you assembled from the templates above. It carries the
exact absolute path AgEnD launches with. For claude-code this matters more than
anywhere: on macOS the login is stored under a Keychain item named after that
path string, so a login under a differently spelled path (a relative
`AGEND_HOME`, a trailing slash, a `~` that was never expanded) lands in another
item, and the agent still finds no login.
For claude-code the refusal also names `/login claude-code <profile>`: offer that first, since it works from chat.

## Create a worker on another subscription

```
create_instance(
  topic_name: "research-b",
  directory: "/home/you/projects/app",
  backend: "kiro-cli",
  backend_options: { "kiro-cli": { "credential_profile": "personal" } },
)
```

The profile name is yours to choose — `work`, `personal`, `team-b`. Reuse the
same name for every agent that should share that subscription.

## Move an existing agent to another subscription

```
update_instance_config(
  name: "research-a",
  config: { backend_options: { "kiro-cli": { "credential_profile": "personal" } } },
)
```

The credentials are read when the CLI starts, so a running instance **is
restarted for you** and the reply says `restarted: true`. A paused or stopped one
is not started: the reply says `restarted: false`, and the switch applies at its
next start.

Set `credential_profile` with `update_instance_config` or web Settings. Never
hand-edit `fleet.yaml`.

**What to do / what not to do, per backend**

**Codex — copy nothing.** A profile swaps only `auth.json`. Changing the profile
does not relocate or copy conversation stores (`sessions/`, `archived_sessions/`,
`state_5.sqlite` and the other thread/state DBs). They stay in the instance's
private `CODEX_HOME` (`~/.agend/cx/<hash>/`); that home links `auth.json` to the
profile's copy. An instance that already has its own `state_5.sqlite` keeps using
that file — it is not always the shared one.

Procedure: (1) the target profile has a Codex login (`auth.json` with a token) —
if the switch is refused, relay that refusal's login command; (2) set the profile
through tooling, as above. A running instance is restarted for you
(`restarted: true`); do not restart it again. A paused or stopped one applies
the switch at its next start (`restarted: false`).

The switch keeps the existing home and history and uses the normal resume path.
Relay `conversation_carried_over` and `conversation_note` from the actual
response. For Codex that flag is true because AgEnD did not force a fresh start —
it is not a check that the new process opened the same thread. If there is no
suitable session (or the DB is unreadable), Codex starts fresh as it would on any
other launch. **Never** copy `state_5.sqlite`, the `cx/` hash dirs or rollout
JSONL by hand. That can fork or corrupt the thread index.

**Claude Code — copy nothing yourself.** AgEnD copies the transcript and its
folder into the new profile and resumes it there with `--continue`. The
originals stay; the switch copies, never moves. Do not copy `.jsonl` by hand.

**Kiro — copy nothing.** Login and conversations share one database, so a
different subscription is a different set of them. Do not copy `data.sqlite3`.
A switch is always a new conversation (`conversation_carried_over: false`);
AgEnD hands the new session a summary of the work (`handover_chars`), not the
transcript.

**For kiro**, a switch is always a **new conversation**
(`conversation_carried_over: false`). Kiro keeps its conversations in the same
database as its login, so a different subscription has a different set of them
and there is nothing to resume — AgEnD does not even try. What it does instead
is hand the new session a summary of what the old one was doing
(`handover_chars` says how much), so the agent can pick the work up without the
transcript. Tell the user plainly: the agent restarted on the other
subscription, it knows what it was doing, it cannot quote what was said.

**For claude-code**, AgEnD copies the transcript and its folder into the new
profile's directory and resumes it there with `--continue`. The originals are
left untouched; the switch copies, never moves.

**Reply fields to relay:**

- `conversation_carried_over: true` — the copy succeeded and the agent resumed
  the same conversation on the new account. The reply also carries
  `conversation_note`: relay it. It says the old copy is still there and
  notes that the switch does not by itself make the prompt cache cold: within
  the same cache scope (organization, and workspace where the provider isolates
  them) an unchanged model and prompt prefix are usually reused. The next turn
  may rebuild it (one slower, full-price turn) when the scope, the model or the
  profile's settings differ, or the cache has expired. Don't promise either.

- `conversation_carried_over: false` + `carry_failed: "<reason>"` — the copy
  could not be made. Common reasons: no session id recorded, not enough free
  space, or the new profile already holds a *different* version of this
  conversation (an existing older copy of the same conversation is replaced
  safely; a different conversation is refused). The instance starts fresh and
  `handover_chars` says how much context the new session received. Relay
  `carry_failed` plainly to the user.

- `conversation_carried_over: true` with no `carry_failed` and no
  `conversation_note` — the backend shares its history across profiles (codex)
  or some other case where no copy was needed; relay the `conversation_note`
  regardless.

**Always read and relay `conversation_carried_over`, `conversation_note` and
`carry_failed` from the actual response.** Do not predict the outcome.

**For codex** the reply says `conversation_carried_over: true` and carries a
`conversation_note`. Relay both as they are. The accurate sentence is "codex
keeps its history outside the login, so both subscriptions still see it". That
flag is not a check that the new process opened the same thread. There is
nothing to copy.

`backend_options` merges per backend, so setting a kiro option leaves a codex
option on the same instance alone.

## Move an agent back to the default login

A merge cannot remove a key, so send `null` for it:

```
update_instance_config(
  name: "research-a",
  config: { backend_options: { "kiro-cli": { "credential_profile": null } } },
)
```

The agent goes back to the login the host uses with no profile set, and is
restarted for the same reason as any other switch.

## Answer "which subscription is this agent on?"

Read it from the instance config (`get_fleet_config` or `describe_instance`):
`backend_options["kiro-cli"].credential_profile`. **No profile means the shared
login** — the one `kiro-cli login` uses on the host with no environment set.
Say "the default login", not "no subscription".

## Answer "how much is left on each subscription?"

`get_usage` returns one row per subscription: `Kiro (work)` and
`Kiro (personal)` rather than a single `Kiro`. Read them out separately — they
are two quotas, and adding them together would give a number that is true of
neither. An agent with no profile appears under the plain `Kiro` row (shown only
while some instance still uses the default login). Codex works the same way:
`Codex (<profile>)` rows next to `Codex (default)`.

Claude Code also has a row per profile: `Claude (work)`, `Claude (personal)`,
next to the plain `Claude` for the default login (again only while some instance
uses it). A profile reads quota from its own login; a profile that is configured
but has never been signed in shows **Not logged in — sign in with
`/login claude-code <profile>`** (in chat, it adds the host command too).

On the web dashboard's usage card (#2014) the title line says just the
provider — "Claude", "Codex", "Kiro" — with the plan badge, and the profile
name sits on its own line under it; the full `Claude (work)` is the tooltip.
`get_usage` and the chat's `/usage` still call the row `Claude (work)`, so name
the profile the way the user sees it on the screen they are looking at.

A kiro profile that is configured but has never been logged in still gets a row,
reading **Signed out — run `kiro-cli` to log in**. That is the reminder to go
and log it in, so report it as such rather than as a missing subscription.

## "Is the prompt cache costing us?"

`get_cache_report({ window?, instance?, top? })` is the dashboard's **Fleet → cache** report.
- **What a row has:** each instance's cache TTL as written and its 5m/1h write mix, the TTL it really behaves as (`effective_ttl`, with the gap-miss rate it is measured from), its expiry cost, and the keep-warm simulation and recommendation.
- **When to look:** when someone asks why costs rose, whether to keep caches warm, or whether to set `backend_options.claude-code.prompt_cache_ttl: "1h"`. A row recommending `switch_to_1h` is the answer to the last one.
- **What you can see:** as General you see every instance and the fleet summary.

## What to tell the user

- Two agents with the same profile name share one login and one quota.
- An agent with no profile uses the fleet's default login, exactly as before.
- Quotas only add up if the profiles are genuinely different billing accounts.
  Two profiles logged into the same account do not double anything, and it is
  worth saying so before someone sets this up expecting more headroom.
- Claude Code profiles now each have their own usage row (`Claude (<profile>)`),
  reading quota from that profile's own login. Every Claude login on the host has a row, whether or not an
  instance runs on it (#2236): `Claude (default)` for the default login, plus every profile. A full subscription
  nothing runs on any more still shows, at 100% with its reset time. Asked "where is my other account?", it is one
  of these rows; it is not missing because no agent uses it.
- Switching a kiro profile does not carry the conversation across; the agent
  gets a summary of the work, not the transcript. Say anything that must survive
  verbatim in the channel before switching. For claude-code, AgEnD copies the
  conversation automatically; relay `conversation_carried_over` and, if it is
  false, the `carry_failed` reason and the cold-cache note from
  `conversation_note` when carry succeeds. For Codex, copy nothing: the history
  stays where it is and the normal resume path runs. Relay the actual
  `conversation_carried_over` and `conversation_note`.

## Do not

- Do not invent a profile that has never been logged in and report success —
  the switch is refused, and the refusal tells you what to relay.
- Do not set `credential_profile` for a backend other than `kiro-cli`, `codex`
  or `claude-code`; it is ignored, and the config validator warns about it.
- Do not copy a Codex agent's `state_5.sqlite`, `cx/` hash dirs or rollout JSONL
  by hand. Set the profile through tooling; a running instance is restarted for
  you. Do not tell the user the agent has resumed the same thread just because
  `conversation_carried_over` is true — relay the actual reply.
- Do not use a profile name with slashes or spaces — it becomes a directory
  name and is rejected.
