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
   - **Move it to the TUI engine** with its conversation (below), if the user wants that.
   - **Wait for AgEnD's migration to V3.** It will convert each conversation once, verify it, and switch the
     instance, one instance at a time and only with the user's confirmation. It is not available yet: say so
     plainly, and never promise a date.

## Never

- Never start, restart, recreate or replace a stopped kiro instance to "try again". It will refuse the same way.
- Never change `kiro_ui` or `backend` to get an instance running. A different engine starts a different
  conversation, and the move cannot be undone. The one way an instance changes engine is the move below.
- Never run `kiro-cli` yourself, and never delete or edit anything under `~/.kiro` or kiro's data directory.
- Never reply to the `[system:kiro-incompat]` notice itself. It is information, not a request.

## Moving an instance from classic to the TUI engine (#2598)

kiro-cli 3.0 drops the classic engine (`kiro_ui: legacy`), so classic instances are being moved to the TUI engine,
**one batch at a time and only with the user's OK for that batch**. The move is `migrate_kiro_instance` (a
coordinator-level tool; you do not have it). It carries the conversation: the instance's classic conversation is
resumed once under the TUI and becomes its own. A fleet admin confirms each move in this General topic: a
"Move it / Cancel" prompt. Explain it if asked; never press it on the user's behalf.

The Confirm prompt warns about sudo/interactive passwords and explains both launches. AgEnD requires an idle
instance, a supported Kiro 2.34+ version and a known model. It carries once, verifies the owned V2 reader, then does
an ordinary restart: while the target CLI is stopped, it archives the exact frozen classic rows before removing
the duplicate from Kiro's index. It verifies the same conversation/model and attached V2 transcript again, and
reports the forensic verdict in General and the instance's topic. Queued work waits until this finishes. Failure
stops and error-pauses the instance; inspect the cause before an explicit retry. Never use a fresh conversation
or classic as a recovery shortcut. Archives are private and restorable with `agend kiro restore-classic` (see CLI docs).
The raw Log-history gate remains closed: the verification proves the launched/pinned reader, not ongoing pane
session identity after `/chat` or `/clear`.

- **After a `/compact`** classic kiro continues under a new conversation id. The move follows the same proven
  compaction chain a classic restart follows and carries the newest conversation. When the chain can't be proven
  (the store can't be read, two conversations continue the old one, or one belongs to another instance), the move
  is refused and nothing changes: tell the user why, don't retry with `start_fresh`.
- After the move, `kiro_engine_status` shows `kiro_ui: tui` and `engine_floor: "tui"`.
- It is one-way. AgEnD refuses to launch a moved instance on classic again, because that would resume the frozen
  classic copy and lose everything done since. A refusal that names the engine floor means someone set `kiro_ui`
  back. The fix is to set it to `tui` again, never to remove the floor.

## Other kiro behaviour users ask about

- **kiro never updates itself under AgEnD.** Every kiro process AgEnD starts carries `KIRO_NO_AUTO_UPDATE=1`, so a
  self-update to kiro-cli 3.0 can't break classic instances. `app.disableAutoupdates: true` in
  `~/.kiro/settings/cli.json` also stops kiro-cli's own updates; that file is the user's to change, not yours.
- **Classic restarts follow a `/compact` (#2714, #2738)** to the conversation kiro kept writing, only on proof it is
  this instance's. When it can't be proven, or the check passes its 30 s / 2 GiB limit, the instance resumes the
  conversation on record and the Log tab says why.
- **Two conversations after an interrupted carry (#2753).** When a stopped TUI instance has its original carried
  conversation and a newer one with work, recovery holds instead of choosing. `reconcile_kiro_instance` (full and
  coordinator tool sets) asks a fleet admin to confirm, in General, keeping the original and archiving the named
  newer one intact. Offer it only after the user chose those exact ids; docs/kiro-reconciliation.md explains it.
- **"Kiro's terminal is in use by another program" (#2682).** While a kiro pane runs `/editor`, `/transcript`, a
  `!` command or a focused `/kvim` panel (legacy: `/editor`, `/reply`, `!`), AgEnD holds deliveries. Tell the user
  to finish or close that program in the instance's pane; held messages go in once kiro's input row is back.
- **A retired model (#2648).** An instance with no model of its own whose saved conversation uses a model kiro no
  longer offers resumes on kiro's default model and says so once. One configured to use that model is told once to
  pick another; it is never switched.

## One kiro agent per instance (#906)

Since kiro-cli 2.21, each AgEnD kiro instance (tui / v2 engine) runs as its own kiro agent, holding only its own
AgEnD MCP server and instructions, and resumes its own conversation by id — instances sharing a working directory
no longer see each other's tools. Legacy (`kiro_ui: legacy`) launches are unchanged.
