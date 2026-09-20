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
in for them: the login is a browser device flow. If the profile named in a
request has never been logged into, the agent will start and report "not logged
in" — so check before promising it works.

Ask the operator to run this on the host once per subscription:

```
XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/<profile> kiro-cli login
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
for you** and the reply says `restarted: true`. Tell the user their agent
restarted: a turn in flight is interrupted, and conversation history does not
move with it — the new profile has its own history.

`backend_options` merges per backend, so setting a kiro option leaves a codex
option on the same instance alone.

## Answer "which subscription is this agent on?"

Read it from the instance config (`get_fleet_config` or `describe_instance`):
`backend_options["kiro-cli"].credential_profile`. **No profile means the shared
login** — the one `kiro-cli login` uses on the host with no environment set.
Say "the default login", not "no subscription".

## What to tell the user

- Two agents with the same profile name share one login and one quota.
- An agent with no profile uses the fleet's default login, exactly as before.
- Quotas only add up if the profiles are genuinely different billing accounts.
  Two profiles logged into the same account do not double anything, and it is
  worth saying so before someone sets this up expecting more headroom.
- Switching a profile does not carry the conversation across. Summarise the
  work before switching if it matters.

## Do not

- Do not invent a profile that has never been logged in and report success.
- Do not set `credential_profile` for a backend other than `kiro-cli`; it is
  ignored, and the config validator warns about it.
- Do not use a profile name with slashes or spaces — it becomes a directory
  name and is rejected.
