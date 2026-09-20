---
name: credential-profiles
description: Run agents on more than one subscription of the same backend. Use when someone asks for a worker on a different account, wants an agent moved to another subscription, or asks which subscription an agent is using. Currently kiro-cli only.
roles: [general]
---

# Credential Profiles

One AgEnD fleet normally shares one login per backend. A **credential profile**
is a named, separate login for the same backend, so two agents can run on two
subscriptions at once.

Only `kiro-cli` has profiles today. For any other backend, say so rather than
setting an option that will be ignored.

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
XDG_DATA_HOME="${AGEND_HOME:-~/.agend}/credential-profiles/kiro-cli/<profile>" kiro-cli login
```

## Create a worker on another subscription

```
create_instance(
  name: "research-b",
  working_directory: "/home/you/projects/app",
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

The credentials are read when the CLI starts, so **the instance is restarted
for you** and the reply says `restarted: true`.

A switch is always a **new conversation**, and the reply says so
(`conversation_carried_over: false`). kiro keeps its conversations in the same
database as its login, so a different subscription has a different set of them
and there is nothing to resume — AgEnD does not even try. What it does instead
is hand the new session a summary of what the old one was doing
(`handover_chars` says how much), so the agent can pick the work up without the
transcript. Tell the user plainly: the agent restarted on the other
subscription, it knows what it was doing, it cannot quote what was said.

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
neither. An agent with no profile appears under the plain `Kiro` row.

A profile that is configured but has never been logged in still gets a row,
reading **Signed out — run `kiro-cli` to log in**. That is the reminder to go
and log it in, so report it as such rather than as a missing subscription.

## What to tell the user

- Two agents with the same profile name share one login and one quota.
- An agent with no profile uses the fleet's default login, exactly as before.
- Quotas only add up if the profiles are genuinely different billing accounts.
  Two profiles logged into the same account do not double anything, and it is
  worth saying so before someone sets this up expecting more headroom.
- Switching a profile does not carry the conversation across; the agent gets a
  summary of the work, not the transcript. Say anything that must survive
  verbatim in the channel before switching.

## Do not

- Do not invent a profile that has never been logged in and report success —
  the switch is refused, and the refusal tells you what to relay.
- Do not set `credential_profile` for a backend other than `kiro-cli`; it is
  ignored, and the config validator warns about it.
- Do not use a profile name with slashes or spaces — it becomes a directory
  name and is rejected.
