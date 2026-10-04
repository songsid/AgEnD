---
name: kiro-engine-migration
description: When kiro-cli can no longer run a kiro instance ([system:kiro-incompat]) — what happened, what is safe, what to tell the user
roles: [general]
---

## When this applies

- You received `[system:kiro-incompat]`. That means the installed kiro-cli could not run one or more kiro
  instances as configured, so AgEnD stopped them and will not retry.
- Or the user asks about kiro's engine change: Classic/legacy UI being deprecated, kiro-cli 3.0, or V3.

## What is true

- **Each kiro instance's conversation lives in its engine's own store:**
  - `kiro_ui: legacy` uses the v1 engine and the classic sqlite store;
  - `tui` uses the v2 engine;
  - `v3` uses the V3/KAS store.
- **Moving a conversation to another engine is one-way.** It forks the conversation: the new engine gets a
  copy, the old one is frozen, and going back resumes the stale copy.
- **AgEnD pins each instance's engine on every launch.** When the installed kiro-cli cannot run that engine,
  AgEnD refuses to start the instance rather than let kiro pick another engine. So a stopped instance's
  conversation is **intact**: nothing was converted or deleted.
- **`kiro_ui: v3` is still refused by fleet validation** until V3 runs unattended. Do not set it.

## Look before you speak

Call `kiro_engine_status` (one instance by `name`, or all of them; ClassicBot kiro instances are included). For
each kiro instance it returns:
- `next_launch`: the flags the kiro-cli AgEnD last probed would launch it with, `refused` with kiro's reason, or
  `unknown` (not probed yet, or kiro-cli did not answer). `kiro_cli.probed_at` says when that probe was.
- `last_launch` and `history`: the kiro-cli and AgEnD versions of the launches AgEnD **prepared** for it, one row
  per change. A row is written before the CLI starts, so it records an attempt, not that the launch worked.
- `v3`: the V3 session it owns, if any.

## What to tell the user

The user has already been shown the plain notice in this topic. When they ask, explain in their own language:
1. Which instances stopped, and that their conversations are safe.
2. Why: quote `next_launch.refused`. Usually the new kiro-cli dropped the legacy UI or the engine the
   instance is pinned to.
3. The options that exist **today**:
   - **Go back to a kiro-cli version that ran them.** `history` shows which versions launches were prepared
     with; the user knows which of those worked. Installing such a version again is the likely way back, but
     do not promise it. The user, or whoever administers the host, does this; you do not.
   - **Wait for AgEnD's migration to V3.** It will convert each conversation once, verify it, and switch the
     instance, one instance at a time and only with the user's confirmation. It is not available yet: say so
     plainly, and never promise a date.

## Never

- Never start, restart, recreate or replace a stopped kiro instance to "try again". It will refuse the same way.
- Never change `kiro_ui` or `backend` to get an instance running. A different engine starts a different
  conversation, and the move cannot be undone.
- Never run `kiro-cli` yourself, and never delete or edit anything under `~/.kiro` or kiro's data directory.
- Never reply to the `[system:kiro-incompat]` notice itself. It is information, not a request.
