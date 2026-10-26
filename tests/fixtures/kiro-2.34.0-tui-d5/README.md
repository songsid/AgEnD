# kiro-cli 2.34.0 TUI: D5, 2026-10-26

Captured on the user-authorized agend-wiki batch-1 migration, `--tui --agent-engine=v2`, carrying its classic conversation. Model stayed `claude-sonnet-4.6`; no account setup, wiki writes, commits, fleet restarts or other panes. The `/model` picker was dismissed with Esc, without selecting anything.

These are real tmux captures at 120 columns. Only historical text above the current UI was removed; the instance agent label and working-directory footer were replaced with scratch names. Composer rows and model-picker chrome are unchanged.

- `busy-steer`: the default busy composer during the read-only shell task.
- `steer-pending`: native input accepted after Enter; one queued tray above the unchanged `Type to steer` composer. The agent acknowledged `STEER_A_SEEN` in that same task.
- `queue-pending`: Ctrl+S queue mode, one native message accepted after Enter. It produced `D5_NATIVE_QUEUE_20261026_C_OK` once on its following turn. The original steer mode was restored.
- `idle`: after all messages, and again after Esc from `/model`; model unchanged.
- `model-picker`: the ordinary, live `/model` picker. This is not a model-unavailable incident.

The six-step read-only shell ran 05:24:19–05:25:09 UTC. Native steer was entered while it ran (between steps 4 and 6). A normal fleet message was also sent at 05:24:55, delivered through the idle queue at 05:25:46 (one attempt), then answered once. The native queue capture was later in the same busy turn; it is not evidence of native queuing during a tool. Immediate captures before Enter did not repaint in time, so no typed-in-box frame is claimed. No legacy pane was inspected in this D5 authorization.

## Findings on deployed 2.3.2-beta.9

B1 fails: the carried metadata says `exported_from_v1: true` and `session_created_reason: subagent`; the transcript reader discards it before applying its owned session pin. Its JSONL grew from 1,498,747 to 1,524,610 bytes during the task. Separately, the forensic envelope scanner still reads classic SQLite. The Log deliberately stays fleet-events-only under `kiro-log-gate.ts` until root/current-session proofs exist; this audit does not open that gate.

B4 passes for native steer and the captured queue behavior; AgEnD's version allowlist previously excluded 2.34.0. B5 passes for normal and busy-queued fleet deliveries (one inbound/one reply each). B6 fails in deployed code: its picker header is `Select model:   type to search`, while the guard recognises only `Select model (type to search):`.

The candidate fixes the pinned exported-session exclusion, holds both picker headers, adds 2.34.0 TUI steering evidence, and makes a TUI forensic scan explicitly unreadable instead of falsely checking classic history. Full engine-aware TUI forensic scanning is still outstanding. Batch 2 remains **NO-GO** on the full B1 criteria; these captures do not claim live validation of an unshipped fix or of a model-outage screen.

The target's final read-only schema check confirmed that `AssistantMessage.data.content[]` embeds `{kind:"toolUse",data:{toolUseId,name,input}}` blocks (474 at that observation). Results arrive separately as `{kind:"ToolResults",data:{message_id,content,results:{<toolUseId>:{tool:null|object,result:...}}}}`. Regression records retain those field names with synthetic values; returned output must not be traversed as a fresh tool call.
