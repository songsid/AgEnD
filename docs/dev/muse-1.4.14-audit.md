# Muse Code 1.4.13-R6996.1 → 1.4.14-R7309.1 audit

Audit date: 2026-10-28, under ffb8104e. Isolation: the new binary ran directly in a disposable `--network none`
container as an unprivileged user, with a scratch HOME per scenario, a private tmux socket and the local Meta Responses
mock. There was no live AgEnD pane, no real account, and the host muse (1.4.13) was not updated. Binary sha256
`0809aac7cb58d18f5022b6d05e02aa1974683c0ec430e5f04d25b60ed17de2da`.

**Verdict: SAFE, no production change.** Every surface AgEnD reads gives the same detector verdict on 1.4.14 as on
1.4.13, and after normalization the panes themselves are the same text. This PR adds fixtures, tests and the capture
script only.

## Precheck findings

| Finding (precheck MAJOR, hard=3) | Result |
|---|---|
| [idle-busy] "Yes, don't ask again this session…" | Neighbour-string noise. The string appears once in each binary (1 → 1), and the precheck's "gone" list holds the same string with its 1.4.13 neighbour. It is not on either approval capture, as on 1.4.13. |
| [idle-busy] "Yes, proceed…" | Same: 1 → 1, neighbour changed. The escalated prompt is still `⟩ 1. Yes, proceed (y)` / `2. No, and tell Muse Code what to do differently (esc)`, and AgEnD holds it for a human with the same request identity as 1.4.13. |
| [error] "continue this session, run checkpoint…" | Not new: `To continue this session, run ` is the `/quit` hint (2 → 2 copies), joined to an unrelated `checkpoint` string. `/quit` still prints `To continue this session, run muse resume <id>`. |
| "to select" 26 → 17 (MUSE_DIALOG_CHROME) | Live trust, login and approval chrome is unchanged: `Use Up/Down or 1/2, then Enter. Esc quits.`, `↓↑ to select · Esc to quit`, `⟩ 1. Yes, proceed (y)`. |
| "Muse Code" 442 → 491 (ready pattern) | The header is `Muse Code 1.4.14`, and the ready pattern matches every idle capture. |
| "rate_limit" 22 → 23 | A 429 still shows `Meta Model API rate limited (HTTP 429) · retrying …`, read as `rate_limit`/`failover`. |
| "Log in to" 2 → 3, "device code" 4 → 5 (startup dialogs) | The logged-out menu is byte-identical to 1.4.13 apart from the version, and still blocks readiness without a key. |
| 9 prompt-like strings away from literals | Seven are in 1.4.13 too (same prefix, different neighbour: Workflow, session-fork, cancel and loader messages). Two are new: agent-definition safe-mode and plugin-config remediation text (`…reopen or resume the Native session, or restart the Workflow runtime…`, `restart the application/runtime and reopen or resume the session`). Neither is on a surface AgEnD reads; the test pins that they trip no error, dialog or resume-missing detector. |

The 1.4.13 usage-limit turn notice (`Usage limit reached` / `This turn stopped because your usage limit was reached.`)
is still in the binary once, unchanged; it stays covered by the 1.4.13 test.

## Re-captured surfaces

Idle, busy, done and Escape on the echo provider; `/quit` and `resume <id>`; resume of an unknown id; the workspace
trust dialog; the logged-out menu; Meta idle and done; escalation denied under production flags; the escalated and the
staged approval prompts (held, same identity); 429 → `rate_limit`/`failover`; an injected 402 → `quota`/`notify`; and the
process-loss resume (`resume_reconcile:orphaned_by_process_loss`) with the stream, a foreground tool and background
work in flight. The resume lands on the same session at an empty idle composer with the abnormal-end warning, writes
reconcile records of the same shape, and `/quit` names the same id.

Sessions are stored under `sessions/YYYY/MM/DD/<id>/` as before; `museSessionDirs` already walks that layout.

Fixture provenance is in [SOURCES](../../tests/fixtures/muse-1.4.14/SOURCES.md). The tests use the production
`MuseBackend` and `session-signals`. Mark audited after this PR merges.
