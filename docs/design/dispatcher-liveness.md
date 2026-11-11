# Telling the dispatcher when an assignee stops

Status: built (#3647). The owner approved it on 2026-11-11 with: quiet 60 min, a "working again" line, notify only. Built as below except where §8 says otherwise.

## 1. Problem

On the task board, a card has an **assignee** (the agent doing the work) and a **dispatcher** (the agent or person who handed
it out). After dispatching, the dispatcher often learns late, or never, that the assignee:

- crashed, or exited and will not come back;
- paused: usage/quota limit, its sign-in ended, an error back-off;
- is sitting on a prompt or permission dialog nobody answers;
- went idle with the card still claimed, without finishing or reporting.

Real case: two agents sat idle for about 6.5 h and 7 h with claimed cards; the dispatcher noticed only when the person asked.
Today the workaround is a scheduled job that polls the fleet.

## 2. What other systems do

**multica** (github.com/multica-ai/multica; tasks.mdx, daemon-runtimes.mdx, server/cmd/server/runtime_sweeper.go,
server/internal/service/task.go) keeps two questions apart:

- *Is the worker alive?* The daemon heartbeats every 15 s; the server sweeps every 30 s and treats a runtime as offline after
  ~150 s without one. In-flight work fails as `runtime_offline` only after a reconnect grace (default 3 h); a daemon restart
  reclaims it at once.
- *Is it making progress?* Daemon-side watchdogs: no output and no tool call in flight for 2 h (`MULTICA_AGENT_IDLE_WATCHDOG`);
  a separate budget while a tool call is in flight. No absolute wall-clock limit by default; the long "running" backstop
  (9000 s) also requires the runtime to be stale.
- A task stuck in `dispatched` times out after 300 s.
- Failures publish `task:failed` on the realtime bus and are posted as a comment on the issue; only transient reasons
  auto-retry (about two attempts); quota, sign-in and model errors never do — they are left for a person.

**Temporal** activity heartbeats (a missed `HeartbeatTimeout` fails the attempt; the last heartbeat can carry progress),
**Celery** (unacked work is redelivered after the visibility timeout, 1 h by default) and **GitHub Actions** (wall-clock job
limits only) show the same spectrum: a liveness signal is cheap and reliable; "no progress" needs generous budgets and a
separate allowance for long-running tools, or it cries wolf.

Takeaways for AgEnD:
1. Separate *down* (process gone, paused, blocked on a person) from *quiet* (alive but no visible progress).
2. *Down* is a fact the fleet already knows: tell the dispatcher at once (or after a short grace for things that fix themselves).
3. *Quiet* needs a generous threshold and must look at every sign of progress, including background work.
4. Push, don't poll: the dispatcher gets one message per episode, posted where it already reads its task board news.
5. Automatic action only for transient failures, and the fleet already does that (crash respawn, wake on delivery).

## 3. What AgEnD already knows

Almost every state above is detected today. None of it reaches the card's dispatcher.

| Signal | Detected | Goes to today |
| --- | --- | --- |
| Crash, auto-respawned | daemon `crash_respawn` | the instance's topic + General, event log |
| Crash loop (3 crashes in 5 min) / supervision ended (retries spent, OOM, exit) | daemon `crash_loop`, `supervision_ended` | the instance's topic, a red status icon |
| Process crashed / stopped | IPC → fleet process status | Needs you item `crashed:<name>` |
| Paused: auth, quota, error, idle, warm cap, operator | lifecycle `pause()` + pause markers | Needs you (auth, usage hold); topic notices |
| Hung with pending work (default 10 min, `hang_detector`) | daemon stuck transition | a nudge **to the assignee itself** naming its claimed cards; Force restart / Keep waiting buttons in its topic |
| Dialog or prompt waiting for a person | `dialog_parked`, `interactive_prompt` | parked notice in the topic + General, Needs you; no time limit |
| Idle / working / stuck state, last activity, claimed cards | the working-state journal (#2473), refreshed on every state edge and board change | log, the web's activity stream; the instance's own resume after a restart |
| Delivery to a down instance | delivery outbox | stays queued; after 3 failed wakes a notice to the sender's topic; 24 h expiry |

The task board's own notices (`[Task board] …`, gathered for 10 s per instance, re-checked before sending, withdrawn when the
card changes) reach the dispatcher only when a card is **blocked** (a question) or waits for **confirmation**. There is no
"claimed too long" or "assignee is down" check. Cards have no last-activity field; the board's event history
(`lastChangeAt`) and the journal's `lastActivityAt` are the closest.

## 4. Proposal

### 4.1 One new board notice: "your assignee stopped"

When an instance that holds a **claimed** card (or one in `review` it still owns) enters one of the states below, the fleet
sends that card's dispatcher one `[Task board]` notice — the same channel, wording style and gathering as today's board news.
Several cards for the same dispatcher and assignee go in one notice.

| Assignee state | When the notice goes | Why this timing |
| --- | --- | --- |
| Will not come back by itself: crash loop, supervision ended | at once | nothing in the fleet will fix it |
| Crashed and respawned | only if it is not running again within 5 min | auto-respawn usually fixes it in seconds |
| Paused: sign-in ended, usage/quota hold, error back-off | at once | needs a person or a reset time; the notice says which, and the reset time when known |
| Paused by idle / warm cap | never on its own — counts as *quiet* (below) | a paused idle instance wakes on the next delivery |
| Paused by a person (operator) | never | the person already knows |
| Hung with pending work (hang detector) | when the hang detector fires (10 min default) | already a judged state |
| Dialog / prompt waiting for a person | after 10 min unanswered | short prompts are answered in seconds |
| **Quiet**: alive, idle, card still claimed, no progress | after 60 min (configurable) | see 4.2 |

Defaults live under `task_board.liveness` (`crash_grace_minutes: 5`, `prompt_minutes: 10`, `quiet_minutes: 60`, `enabled: true`).

### 4.2 "Quiet" without crying wolf

An assignee counts as quiet only when **all** of these hold for `quiet_minutes`:
- its execution state is idle (or idle-paused), not working, not stuck;
- no board event on the card (log line, state, comment, move, check) and no message from the assignee to anyone;
- no tool activity (the same tool events that feed `tool_progress`), no live subagent, and the working-state journal shows no
  background task (`background` empty, nothing `waiting` or `owed`);
- it is not waiting on a reply it asked for (an open request with a correlation id) — then the notice would go to the wrong
  place; that case is shown as "waiting on <instance>" if it ever crosses the threshold.

Long-running work that looks idle (subagent testers, a background build) shows up in tool activity, subagents or the journal's
background field, so it does not trip the rule. An agent can also mark a card "waiting until <time>" with a log line
(`task update … log`), which counts as progress.

### 4.3 One notice per episode, cleared when it is over

- **Key:** `task-liveness:<dispatcher>:<card>:<state>:<episode start>`, admitted with the existing idempotent system-notice
  path, so a restart of the fleet never repeats it.
- **Re-check at send time:** like today's board wakes, the notice is dropped if the assignee recovered, the card moved, or the
  card changed hands during the 10 s gathering.
- **Clear:** when the assignee is back (running again, prompt answered, sign-in restored, progress seen), a still-queued
  notice is withdrawn; one that was already delivered gets one short follow-up ("M-12: <assignee> is working again"). No
  repeats while the same state continues; a new episode (a new crash, a new quiet hour after progress) is a new notice.
- **Planned restarts and updates** (`agend update`, fleet restart) are suppressed the same way incident notices already are.

### 4.4 What the dispatcher sees

In chat (an agent dispatcher), one line per card plus what it can do:

```
[Task board] M-12 "Fix the login retry" — its assignee <name> stopped: sign-in ended (Claude Code), paused since 10:42.
  It needs a new sign-in. You can: reassign the card, or ask the person to sign it in again.
[Task board] M-15 "Port the parser" — its assignee <name> has been quiet for 1 h 05 min with the card claimed
  (idle, no board update, no tool activity). You can: ask it (send_to_instance), wake/restart it, or reassign.
```

On the web: the card shows a small badge on the board ("assignee stopped · sign-in ended"), and a card whose dispatcher is a
**person** puts the same line in Needs you (that is where a person's task news already goes).

### 4.5 Who acts

The fleet only tells. It already restarts crashed instances and wakes paused ones on delivery; it does not reassign work or
restart a quiet agent on its own, because a quiet agent may be thinking, and a reassignment is the dispatcher's call. The
notice lists the actions; the dispatcher (an agent with `restart_instance` / `wake_instance` / the board) or the person
decides. An opt-in "restart a quiet assignee once" can come later if the notices show it would be safe.

If the dispatcher itself is down or deleted, the notice follows the existing rule for blocked cards of a missing dispatcher:
it goes to the person (Needs you).

### 4.6 What replaces the polling schedule

The push notice covers the cases the schedule was polling for. For a look on demand, the board gets one filter:
`task list` with `stale: true` (cards whose assignee is down or quiet, with the reason) — the same check the notice uses, so
the two never disagree. The polling schedule can then be deleted.

## 5. Where it plugs in

- **One evaluator** next to the working-state journal update (`observeWorkingState`), which already runs on every execution and
  process edge, every pause, every board change, and loads the instance's claimed cards. It decides the state per card and
  starts or ends an episode.
- **One timer** for the time-based rules (crash grace, prompt minutes, quiet minutes): the existing 30 s reply-obligation sweep
  or the Needs you backstop tick.
- **Sending** through the task board waker (a new wake reason, e.g. `assignee_stopped` / `assignee_back`) so gathering,
  re-checks, withdrawal and the board-off switch come for free.
- No change to delivery, the daemon, or the backends.

## 6. Tests to write with the code

- Each state in 4.1 → exactly one notice to the dispatcher, none to anyone else; none when the dispatcher is the assignee.
- Crash + respawn within the grace → no notice; past it → one.
- Quiet: an idle assignee with tool activity / a subagent / a journal background task / a log line → no notice.
- Recovery before send → withdrawn; after send → one follow-up; the same state continuing → nothing more.
- A fleet restart in the middle of an episode → no repeat (idempotent key).
- `agend update` restarting every instance → no notices.
- Person dispatcher → Needs you item, cleared on recovery.

## 7. Out of scope

Automatic reassignment or restart of quiet agents; heartbeats from inside the CLIs; per-card time limits; changes to how
crashes are retried.

## 8. As built

- **Sending:** not through `TaskBoardWaker`. Its notice keys carry a timestamp, but one episode must be admitted once
  across restarts. `src/dispatcher-liveness.ts` sends through the same path (`admitTaskBoardNotice`, the `[Task board]`
  format, the board-off switch) with a key per episode (`task-liveness:<dispatcher>:<since…>:cards=<uuids>`). The episodes
  live in the scheduler database (`task_liveness`, `src/scheduler/task-liveness.ts`). One sweep's news for a dispatcher is
  one message, which is the gathering.
- **Recovery** needs positive evidence: a working edge (after the 5 min startup grace), a card update or a message after
  the episode began. A clock below its threshold is not enough, because after a fleet restart the idle clock starts again.
  A notice still waiting is withdrawn once no card on it is still stopped. Otherwise the "working again" line follows it.
- **Background work:** the backend's `backgroundWorkRunning` (muse today) or a live subagent (the dashboard's subagent
  reader), asked only before a quiet notice.
- **Person or missing dispatcher:** only *quiet* becomes a Needs-you item (`task_stalled`). Crashed, sign-in, usage, a
  waiting prompt and a hang already have their own instance items.
- **A dispatcher agent that is not running** (stopped, crashed, paused) when the notice goes out (the leader,
  2026-11-11): the notice still waits in its queue, and the episode is also raised in Needs you (`needs_you` on the
  episode), like a missing dispatcher's.
- **Startup grace:** nothing is judged for 5 min after the fleet starts, and nothing during a planned restart or update.
- **Settings:** Settings → Agent defaults → "When an assignee stops" edits `defaults.task_board.liveness` (`enabled`,
  `quiet_minutes`, `prompt_minutes`, `crash_grace_minutes`; minutes 1–1440).
