# Muse Code 1.4.12-R6909.1 → 1.4.13-R6996.1 audit

Audit date: 2026-10-25, under ffb8104e. Isolation: both binaries run directly in disposable `--network none` containers as an unprivileged user, with a scratch HOME/XDG, a private tmux socket and the local Meta Responses mock. There was no live AgEnD pane, no real account, and the host muse was not updated. Binary sha256 `51e97f8de0aa175080e6576cbc055510a95dfe0ededf175c7f6b34fc8e3bf524`.

**Verdict: SAFE, no production change.** Every surface AgEnD reads gives the same detector verdict on 1.4.13 as on 1.4.12. This PR adds fixtures and tests only, plus a `slow` mode for the audit mock.

## Precheck findings

| Finding (precheck MAJOR, hard=3, hinted=2) | Result |
|---|---|
| `continue this session, run resume_reconcile:orphaned_by_process_loss` | Not new. The reason code is already in 1.4.11 and 1.4.12; 1.4.13 has a few more copies (lines holding it: 20 → 24). The precheck joined it to an unrelated neighbour: `To continue this session, run ` is the `/quit` hint. It was exercised live; see below. |
| "usage limit" 4 → 5, `usage limit was reached.` | **New** turn notice: `Usage limit reached` / `This turn stopped because your usage limit was reached.` / `Check /usage for details.` / `Send a message to continue when usage is available.` In 1.4.12 the title stood alone. `/quota\|usage limit\|out of credits/i` matches it as `quota`/`notify`, and `rate_limit` does not. Not reachable offline (see SOURCES), so it is pinned with the binary's exact text. |
| "Usage limit reached" | 1 → 1. It is the title of the notice above. |
| "to select" 29 → 26 (MUSE_DIALOG_CHROME) | Live trust, login and approval chrome is unchanged: `Use Up/Down or 1/2, then Enter. Esc quits.`, `↓↑ to select · Esc to quit`, `⟩ 1. Yes, proceed (y)`. |
| "Muse Code" 438 → 442 (ready pattern) | The header is still `Muse Code 1.4.13`, and the ready pattern matches every idle capture. |
| "muse login" 33 → 36 (startup dialogs) | The logged-out menu is byte-identical to 1.4.12 apart from the version. |
| "Resume this session; address it in Peer messages." | The `/name` slash-command help ("Name: …" between `/name` and `/rename`). 1.4.13 carries a second copy of that command table, which is why its count went from 1 to 2. It is not a prompt. |
| "Yes, don't ask again this session" | Neighbour-string noise: the string appears once in each binary, and it is not in either approval capture. |

The empty-composer hint catalog (#2520) is identical in both binaries. Only an internal `monitor` id key was dropped from the blob.

## The process-loss resume path

This is what happens when the fleet restarts a muse instance whose process died. It was exercised four ways on both versions:

- the model stream in flight, SIGKILL;
- a foreground `sleep 300` tool running, SIGKILL;
- the same tool, `tmux kill-server` (SIGHUP);
- backgrounded work, SIGKILL.

Each was followed by AgEnD's `… --disable-approval --trust-workspace … resume <id>`.

- **No new dialog or prompt.** muse reopens the same session id at an empty idle composer and prints `warning: the previous run of this session ended abnormally around … (no clean shutdown was recorded). It was resumed cleanly.`
  - The in-flight turn shows `◆ Interrupted`.
  - A running tool shows `◆ Review sleep 300 — unresolved / └ manual reconciliation required`. That is transcript text, not a prompt.
  - The next pasted turn completes, and `/quit` names the same id.
- **On disk,** the resume writes the reconcile records to `session.jsonl`: a `runtime.session` run `terminal: cancelled` plus a task `cancelled` for each orphaned task, all with `reason: resume_reconcile:orphaned_by_process_loss`.
  - They have the same schema and keys as 1.4.12.
  - `entryKind` reads them as `runtime.session:run` / `:task`, which `isTurnKind("muse")` already counts as turn evidence.
  - `route_facts` still names the cwd, so `getSessionId` still finds the session.
- **AgEnD's verdicts** on the resumed panes: ready, idle, no draft, no dialog, no error, not `resumeMissingPattern`, no background work. The same verdicts hold on 1.4.12.
- **Rig trap:** without a reaping PID 1, a HUP'd muse becomes a zombie whose pid still holds the session lock, and `resume <id>` opens the session picker. This happens on both versions, and not under `--init`. It is a container artifact, not muse behaviour. A host reaps its zombies.

## Re-captured 1.4.12 surfaces

All of these match 1.4.12 after normalization:

- idle, busy, done, and Escape restoring the draft;
- resume, and resume of an unknown id;
- the workspace trust dialog and the logged-out menu;
- escalation denied under production flags;
- the escalated and staged approval prompts, still held for a human with the same request identity;
- 429 retry → `rate_limit`/`failover`, and an injected 402 → `quota`/`notify`.

Fixture provenance is in [SOURCES](../../tests/fixtures/muse-1.4.13/SOURCES.md). The tests use the production `MuseBackend` and `session-signals`. Mark audited after this PR merges.
