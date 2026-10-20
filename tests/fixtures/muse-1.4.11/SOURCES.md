# Muse 1.4.11-R6667.1 — isolated captures, 2026-10-20

Real downloaded binaries, executed directly (never the installed `muse` launcher):

| Version | SHA256 |
|---|---|
| 1.4.10-R6427.1 | `decefc0fb33c48ee43419c3e72ac2dbc781743868611074c7292807f5960dfcf` |
| 1.4.11-R6667.1 | `6fda12a6a4f236528dafa707384cf6395fe859b1438ef77c7be26ed9d7976839` |

Author's new captures, separate from dev-claude's handoff: disposable Docker container `agend-muse1411-audit`,
`--network none --memory 2g --memory-swap 2g --cpus 2 --pids-limit 256`, non-root `rh`, scratch HOME/XDG per scenario.
All tmux operations explicitly selected `/home/rh/audit/tmux.sock`, 120×36. No AgEnD fleet/daemon handler, host tmux,
installed CLI, credentials or vendor endpoint was used. Container-only shell probes use harmless echo/sleep commands.

Only normalization: `/home/rh/audit/work` → `/tmp/muse-audit/work`, trim trailing spaces, drop tmux's own
`Pane is dead ...` row. Blank rows, session IDs, timer values and CLI text are retained. Session route records are one
unaltered JSON line selected from the real log (same workspace replacement), not invented schema fixtures.

The logging [Meta mock](../../../scripts/manual/muse-version-audit/mock.py) binds 127.0.0.1:18800 inside the offline
container. The catalog is `{"data":[{"id":"mock-model"}]}`. The Responses SSE events include `sequence_number`;
function calls use `name:"bash", namespace:"muse"`. A per-session `prompt_cache_key` prevents an old session's
cleanup request from consuming another scenario's one tool response. The mock distinguishes reminder-child requests
from the main agent. `META_API_KEY=dummy-audit-only` is not a credential.

Launch environment: `env -i HOME=<scratch> XDG_CONFIG_HOME=<scratch>/.config PATH=/usr/local/bin:/usr/bin:/bin
TERM=xterm-256color LANG=C.UTF-8 MUSE_UPDATE_INTERVAL_SECONDS=31536000`, with that dummy key for Meta.
Paste: `tmux -S <socket> set-buffer -- <text>`, `paste-buffer -p`, separate Enter after a short settle.
Root flags precede `resume <uuid>`, matching `MuseBackend.buildCommand`.

| Capture | Procedure |
|---|---|
| echo-idle/busy/done | `--provider echo --disable-approval --trust-workspace --echo-delay-ms 3000`; paste `echo audit turn`, capture pending and after completion |
| echo-after-escape | next echo turn `cancel this audit turn`, Escape while pending; restored draft remains |
| echo-quit/resumed | clear draft with C-u, `/quit`; resume the saved UUID with the same flags |
| resume-missing | resume nonexistent UUID `01a00000-0000-7000-8000-000000000000`, include history |
| first-run-trust-dialog | fresh HOME, no bypass flags |
| offline-first-run | fresh HOME, only `--trust-workspace`, no login |
| meta-idle/done | `--provider meta --base-url http://127.0.0.1:18800 --model mock-model --disable-approval --trust-workspace`; wait for rendered prompt, then text response |
| prod-escalation-denied | same production flags; mock bash `echo harmless-audit`, `sandbox_permissions=require_escalated`; Muse denies, no approval prompt |
| approval-escalated | same mock, only `--trust-workspace`; existing two-option dialog |
| approval-untrusted-staged | mock ordinary `echo harmless-audit`, `--trust-workspace --approval-mode untrusted`; existing three-option staged dialog |
| approval … cursor2/after-esc | Down once, then Escape; never Enter or an allow key |
| prod-rate-limited | production flags, local mock HTTP429 (`rate_limit_exceeded`, retry-after2); retry row captured |
| prod-usage-limit | production flags, local mock HTTP402 `{error:{message:"Usage limit reached",type:"usage_limit_reached"}}`; this is injected protocol evidence, not a real exhausted subscription |
| prod-background-work | production approval/trust flags **plus `--disable-sandbox`**, solely to run in this container; bash `sleep 120`, `yield_time_ms=100`; completed turn with live local task panel |
| prod-quit-with-local-work/cursor2/after-esc | `/quit` with that task running; Down once; Escape; never choose Exit anyway |
| compare-1.4.10-* | identical scenarios against the previous binary |
| session-route-facts.jsonl | real session head's route-facts event, still within the first64KiB |

An initial meta-idle snapshot was taken before the screen rendered. The test rejected it; the committed fixture is a
new live capture after observing the actual ready prompt. The initial background harness used an unsupported argument
and a global mock sent-marker; it is not the committed background evidence. The committed captures use the actual
`yield_time_ms` schema and per-session mock state. These setup failures are not mutation evidence.

Scope: the literal `Yes, don't ask again this session` exists once in both binaries, but was not reached in the two
shell approval shapes. Extra read/write-file probes did not reach it either. These captures do **not** prove every
enterprise permission profile or generic approval UI is handled; that pre-existing limit is explicit in the audit report.
