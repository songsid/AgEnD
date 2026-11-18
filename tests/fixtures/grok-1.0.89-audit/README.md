# Grok 1.0.89 audit

This packet runs the real Linux x86_64 CLI in a network namespace, scratch
HOME and private tmux server with a local API mock and dummy key. No real
account, installed CLI, Fleet pane or browser was used.

| Binary | SHA-256 |
| --- | --- |
| 1.0.88 baseline | a33013fe73ea63d2f18df636f90f84060a88712f9932b77cda0447dd83b4bfe5 |
| 1.0.89 | a3dface51d9bdc71fd121e0481dd02d9b46a721f7a6b892f756480e9666eba1f |

The audited binary identifies itself as `grok 1.0.89 (28be5bb1bf65)`.

## Finding and change

Compaction can display `Compaction failed: Unauthorized (401)` followed
by `usage limit reached` or `out of credits`. AgEnD matched the broad
authentication rule first and paused for login. The new specific quota
rule precedes it. It requires the compaction error's box prefix and at
most four adjacent continuation rows, including word wrapping at both
120 and 80 columns. Real authentication failures retain their classifier.

The same compaction behavior was reproduced on 1.0.88. This is an existing
gap found by the audit, not a claim that 1.0.89 introduced it. Ordinary
401 turns discard the server payload and show only `Authentication
required`; the audit does not infer quota from text that is not rendered.
Their existing classification is unchanged.

The new fixtures first fail as `auth_error` instead of `quota`. Removing
the new rule reproduces the failure, and removing its frame guard turns
the prose negative red. The restored tests pass. Other historic broad
auth/quota false positives are outside this narrow change.

## Precheck disposition

The precheck reports `MAJOR`, `hard=1; hinted=4`, with no missing detector
literal. Its alleged new usage/status phrase already exists in both
binaries: the following neighbour changed. Both compaction renders were
therefore probed rather than assuming a new terminal string.

- Trust: the same question, Yes/No choices and `y` action remain usable.
- Build count and memory neighbours: no change to the live sign-in hold
  footer; unauthenticated input remains blocked with no guessed key.
- Rate limit: the actual 429 retry block retains the known framed payload.
  The `sleeping.` neighbour itself is static-only evidence.
- Remaining prompts concern history/filter/editor controls, goal resume,
  terminal/mosh advice, scrollback expansion, subagent permissions and
  usage JSON. They are optional/static-only observations; no claim of
  exercising every optional submenu or account-dependent feature is made.

## Replay and limits

`rig/run.sh` invokes only the supplied binary in `bwrap --unshare-all`.
The terminal and local mock are real processes; model responses and API
failures are synthetic. Select `AUDIT_PHASE=full`, `compact-errors`,
`usage-errors`, `login` or `weekly-reset`. The controller closes its tmux
server and mock in `finally`. The import/download directory is private
and is not committed.

```sh
GROK_BIN=<retained-binary> AUDIT_DIR=<owned-scratch> AUDIT_PHASE=full \
  bash tests/fixtures/grok-1.0.89-audit/rig/run.sh
```

Login was not completed: discovery/device endpoints are inaccessible in
the isolated network. Empty or timed-out login commands are recorded as
unreached, never successful. No real-account service, Windows binary or
installed-package upgrade was tested. The supplied precheck found no
changelog; this packet does not claim one was available.

The initial imported binary lacked execute permission; that attempt
never launched it. Two early broad passes exposed harness assumptions:
an asynchronous input record was sampled too soon, and an error block
replaced the previous block rather than increasing its text count. The
controller now waits briefly for the exact record and uses fresh error
sessions. A transient empty pane during resume also gets retried within
the existing bound. Raw failed attempts remain private and are not
counted as passing runs.

## Rollback

Revert the narrow error rule and rebuild the detector manifest. This
restores the earlier authentication classification for the compaction
denial. The audit changes no installed CLI or real account configuration.
The dev twin additionally updates its audited-version ledger with this
evidence; that update target must be reverted together if rolling back.
