# Grok 1.0.88 audit

Real Linux x86_64 CLI captures, with a local model API mock. No real account,
credential or Fleet was used. The installed CLI was not changed.

| Artifact | SHA-256 |
| --- | --- |
| 1.0.77, retained baseline | b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a |
| 1.0.88, audited binary | a33013fe73ea63d2f18df636f90f84060a88712f9932b77cda0447dd83b4bfe5 |

The new binary reports `grok 1.0.88 (2fe3608f7398)`.

## Changes found live

- The weekly-limit scrollback legend is now `Tab:question`, rather than
  `Tab/Space:question`. Space and X leave that focus state unchanged.
  A literal tab restores the picker; X then dismisses it. The same tab/X
  sequence works on 1.0.77. The request-count fixtures prove that neither
  sequence sends another POST. The detector now recognizes both exact
  legends and uses the common literal tab. It never chooses a paid option.
- An unauthenticated 1.0.88 launch can show `Sign in with Grok` and `Quit`
  above a prompt-shaped box, including when authorization discovery fails.
  The broad ready detector sees that box. A specific startup/runtime hold
  now recognizes the ordered choices and the active build footer and
  sends no keys. This was found during this audit; its introduction version
  has not been established.
- Server-error retries now use a Unicode ellipsis and are recognized as
  busy by the existing detector. This repairs an upstream rendering gap
  noted in older audits without changing our busy expression.

## Retained contract

`panes/` contains actual 120- and 80-column renders: startup trust, idle,
working/completed turns, short and collapsed drafts, taken/queued input,
cancel, errors, weekly limit, tools/MCP, compact/new, quit/resume and model
switching. `weekly-scrollback.pane.txt` and `login-unavailable.pane.txt`
are the two regression inputs. Historical fixture text was not rewritten.

The JSONL files contain actual structured `user_message_chunk` records.
Before Enter and after a never-sent paste they are empty. The submitted
record is present before the model's delayed answer. A wrong UUID or an
assistant record cannot prove input.

The real MCP stub received one `tools/call` for `reply`. The existing
production Daemon/TmuxManager model-switch rig also confirmed
`/model grok-4 high` and `/effort low` on this binary. Unknown-model refusal
was captured. No inline-switch source change is needed.

## Isolation and replay

The scripts in `rig/` run under `bwrap --unshare-all`, with a fresh HOME,
private tmux socket, no external network, dummy key and local mock. The
actual Node executable is mounted explicitly because host-specific Node
paths are hidden. They launch the CLI directly, never a Fleet lifecycle
handler. Every pane capture must be nonempty; children and the owned
server/listener close in `finally`.

```sh
GROK_BIN=<retained-binary> AUDIT_DIR=<owned-scratch> AUDIT_PHASE=full \
  bash tests/fixtures/grok-1.0.88-audit/rig/run.sh
```

Focused phases are `weekly`, `weekly-reset`, `tail`, `dashboard`,
`login`, `login-commands` and `extra-errors`. Model-route replay uses the
existing `scripts/manual/grok-version-audit/switch-rig.sh` with
`GROK_VERSION=1.0.88 DAEMON_PROOF=1` and an owned `TMPDIR`.

The first broad pass reached 51 nonempty screens, then stopped because a
benign echo command was automatically accepted instead of prompting.
The approval-only continuation used an owned scratch removal/local-fetch
command and explicit default permission mode to reach the actual card.
A second fixture repair removed an incorrect start-of-string assumption
about the mock's JSON user content. Neither required a product change.
A rate-limit text frame was captured again in a fresh session because an
old history match let the first waiter finish early. These raw attempts
remain private; they are not counted as successful terminal evidence.

## Limits

This is real-terminal evidence against synthetic model responses, not
real-account end-to-end service validation. OAuth was not completed:
external discovery/device endpoints are unreachable in the isolated
network. The no-key TUI was captured; plain `grok login` had no rendered
screen within its ten-second bound, and device login reported DNS failure.
Neither is counted as a successful login flow. No Windows CLI was run.

The pre-existing statusless 401/403 usage classification and unmatched
optional tool-permission card remain outside these two repairs. The
normal launch uses `--always-approve`. The audit does not broaden an
approval regex or guess a new menu choice. Optional/unreached strings are
listed separately in the audit note; binary text is not live proof.
