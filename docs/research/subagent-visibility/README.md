# Research: showing CLI subagents in AgEnD

**2026-11-09 · M-2739 · proposal only; no feature implementation.**

**繁中摘要：可以做，但應讀 CLI 的結構化紀錄，不要從聊天文字猜。** Claude Code 2.1.319 的實測有 `Agent` 呼叫、背景啟動結果、sidechain 子檔與完成通知；Codex 0.167.0 有 `spawn_agent` 的子 rollout，另有不同的 `create_thread` 獨立工作。可顯示名稱／類型、任務、CLI 最近回報的狀態、可證明的耗時與結果摘要。失聯或紀錄不完整顯示「狀態待確認」，不假裝仍在執行或已完成。建議先做父訊息下可收合的唯讀列；目前只有真實 web shell 的靜態提案圖，等使用者選擇後才實作。M-2722(b) 的 Hub 卡片提案仍維持等待使用者選擇。

## Result and exact scope

Actual interactive Claude Code **2.1.319** and Codex **0.167.0** ran against owned local mock APIs. The CLIs, their tool dispatch, child creation, transcripts and completion records were real; model decisions and answer contents were deterministic mock responses. This proves observable CLI mechanics, **not** real-model delegation quality or real-account behavior. Binary SHA256s are in [binary-manifest.json](binary-manifest.json). Research base: alpha `47106e8d0c3769021e30881b026ff7707747e72f`.

The owned rig used scratch HOME/CODEX_HOME/Claude config, `env -i`, an explicit private tmux socket, no vendor credentials, and an unprivileged user+network namespace (`unshare -Urn`). Only namespace loopback was brought up: no external routes, no host networking changes. Claude updater/telemetry flags and Codex startup update checking were disabled. The network namespace prevents vendor traffic even if a flag changes. This was **not a filesystem jail**: the work directory was under our checkout; CLI startup could read its inherited project instructions. Those instructions/API blobs are omitted from public fixtures. Tool work was limited to two owned marker files (Claude Read) or plain mock replies (Codex); no model shell calls occurred. No live fleet, real account, Windows Runtime or native Windows run.

### Actual cases

| Case | Observed result | Evidence |
|---|---|---|
| Claude two parallel background `Agent`s | `reader` and `checker`; distinct IDs/files; one finished while the other was live; then both completed | `fixtures/claude-parent.jsonl`, child `.jsonl` and `.meta.json`; `panes/claude-subagents-live.txt`, `claude-finished.txt` |
| Codex two `multi_agent_v1.spawn_agent`s | Descartes and Kant; two child threads, explicit parent binding; both child turns completed | parent `01a1bf2c-0674…`, children `01a1bf2c-55a3…` / `01a1bf2c-57b5…`; live/final panes |
| Codex separate `mcp__codex_tui.create_thread`, policy `never` | Tool refused: approval required. No successful task ID. Mock model nevertheless said it had created work | `01a1bf2c-bb82…`; `panes/codex-thread-work.txt` |
| Same separate-task tool, `on-request` | Actual tool approval shown; researcher approved only this owned synthetic task. Returned new thread ID; child turn completed | parent `01a1bf2f-4617…`, child `01a1bf2f-ceb2…`; approval/final panes |

Pane captures have only owned-path substitution and trailing blank/space trimming. Full selected filenames and original/export hashes are in [manifest.json](manifest.json). There are **13 selected fixture files / 62 actual records**. No events were fabricated to fill gaps. Full raw requests/transcripts remain privately in the owned `.artifacts/m2739/` archive. An early restricted Claude launch advertised Read only; we then changed launch mode to expose Agent. An early Codex rerun accidentally reused the previous namespace's **owned** daemon and could not reach the new mock port; fresh CODEX_HOME fixed the rig. A first approved separate-task mock did not recognize delegated input and waited on another approval; that exploratory attempt is excluded from the accepted case. None is attributed to product behavior.

## What each CLI exposes

### Claude Code 2.1.319

The captured tool is **Agent**, not a guessed legacy `Task` schema. Its actual declaration accepts `description`, `prompt`, `subagent_type`, optional model/effort/isolation. This build did **not** advertise `name` or `run_in_background`; the CLI launched the calls in the background itself. Older Task spellings need their own adapter/fixtures; this research does not certify them.

A parent assistant `tool_use` carries task/type and `tool_use.id`. The corresponding parent `toolUseResult` carries `status: async_launched`, `isAsync`, `agentId`, description, prompt, model and output path. Files are:

```
<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<parent-session>.jsonl
<same>/<parent-session>/subagents/agent-<agentId>.jsonl
<same>/<parent-session>/subagents/agent-<agentId>.meta.json
```

Child records have `isSidechain: true`, `agentId`, and **the parent's sessionId**; child `parentUuid` alone is not a cross-file parent-session identifier. The sidecar has `agentType`, `toolUseId`, description, spawnDepth, requestShape, model and `finished`. Parent `origin.kind: task-notification` records bind task ID/tool-use ID, `status: completed`, result and `<usage><duration_ms>…` (8464 / 12300 ms here). The pane rounded these to 8 / 12 seconds.

A notification explicitly says the **same task ID may notify again after another message/resume**. Track a child run/turn generation, not one permanent completed flag. `finished: true` is useful supporting evidence, not an immutable lifetime fact. Sidechain records and tool outputs can contain sensitive source text; the first slice needs only task/result metadata, not a dump of the entire child transcript.

### Codex 0.167.0: two different relationships

**Subagents.** The isolated Codex config explicitly set `[features] multi_agent = true` to exercise this capability; this does not establish the default on every AgEnD/CLI installation. The actual `multi_agent_v1` namespace advertises `spawn_agent`, `send_input`, `wait_agent`, `close_agent`, `resume_agent`. `spawn_agent` returned CLI-assigned UUID and nickname. The observed schema did not have caller `task_name` or `agent_type`. Child `session_meta` has distinct `id`, explicit `parent_thread_id`, `thread_source: subagent`, `source.subagent.thread_spawn` with depth/nickname/role, and `agent_nickname`. Importantly, child `session_id` in this build equals the **parent** ID: do not confuse it with the child `id`.

Each child has its own rollout under `<CODEX_HOME>/sessions/YYYY/MM/DD/`. `task_started.turn_attribution` binds parent/root turns. `task_complete` carries exact child turn, timestamps, duration_ms (8682 / 8437 ms here) and `last_agent_message`. `wait_agent` can return **only one of several requested children**; the captured output did. The parent's mock prose claiming both done must not replace per-child evidence.

**Independent task threads.** `mcp__codex_tui.create_thread` is a different, approval-gated tool. Its successful result is a content-block array containing JSON with `threadId` (not necessarily a raw JSON output string). The child was `thread_source: user` with **no parent_thread_id**. Its initial CLI-authored `function_call_output`, namespace `codex_tui`, contains `<codex_delegation><source_thread_id>…` and the delegated input. Correlate that to the parent's successful tool call/result; merely sharing cwd or appearing in `list_threads` is insufficient. Parent and child have separate root turn IDs. Optional title is model-supplied task text, not a verified identity. The task title was not in our child's session_meta, so retain the successful call's title when present.

The CLI also made an automatic model request with `thread_source: thread_title` during inspection. A new request/thread is **not automatically a user subtask**. `fork_thread` and arbitrary task boards/plan items were advertised or adjacent concepts but were **not exercised**. A to-do/task-set entry is not itself proof of another running agent.

## Reliable display contract

| Field | Claude | Codex subagent | Codex independent task | Safe UI behavior |
|---|---|---|---|---|
| Who | agentType + description; internal agentId | CLI nickname; optional role/path if present | retained title, otherwise “獨立工作” | Do not invent a human name or expose internal IDs by default |
| Task | actual Agent prompt/description | actual successful spawn input | approved successful create_thread input | Render as untrusted text, bounded and escaped |
| Started/live | successful async launch + current observation | successful spawn + child's started turn | successful creation + child's started turn | “執行中” only for a currently observed open run; disconnect/gap → “狀態待確認” |
| Finished | matching CLI task notification / run | child's matching task_complete or explicit returned child status | matching child's task_complete | A parent's final answer/idle state does not finish children |
| Duration | CLI-reported duration_ms when available | matching task_complete.duration_ms | matching task_complete.duration_ms | Wall/turn duration, **not CPU time**. Otherwise approximate elapsed only while observation is current, or omit |
| Summary | notification result or bounded final child text | completed child last_agent_message | completed child last_agent_message | Label as child report; no independent correctness claim |

Missing finish, unreadable files, old/incompatible CLI schema, truncation, rotation or disconnected Runtime must yield **unknown/incomplete**, never fabricated success or permanent “running”. Do not make new API requests merely to populate the UI. An explicit CLI approval wait/refusal can be shown as such; this research does not prove an AgEnD Needs-you approval bridge for children, and the read-only display must never auto-approve it. Keep hidden thinking/internal system prompts out of the UI; show only bounded final returned text. First-level children were tested; arbitrary-depth trees, cancellation/resumption, remote-worktree agents and every legacy version were not validated. They need fixtures before claiming complete coverage.

## Fit with AgEnD and smallest first slice

Existing progress already parses tool calls and turn events. `src/transcript-records.ts` reduces tool outputs to progress and does not retain the identity/status/result relationship needed here. `src/transcript-sources.ts:matches` deliberately rejects Codex `subagent` rollouts: keep that guard. Otherwise the newest same-cwd child can be mistaken for the main CLI's session and alter delivery/readiness. A **separate bounded observation lane** should join child relationships to the exact owned parent session and turn.

Recommended first implementation after design approval:

1. A read-only child-run model keyed by owner/launch generation, parent session+turn, call ID, child ID and child run. Begin with Claude Agent and Codex spawn_agent. Include independently created Codex tasks under a separately labelled “獨立工作” group once their full successful call/delegation edge is retained; don't conflate them with sidechains.
2. Keep discovery/read concurrency, bytes/line size, active children, nesting and retained results bounded. Resolve only allow-listed files within the owning CLI home, reject symlink/path escape and mismatched metadata, coalesce watches/polls. Treat sidecar rewrites/partial JSON and duplicate/replayed notifications as ordinary conditions. Persist only minimal metadata for reload; never replay old completions as new chat messages.
3. Put a collapsed **子 Agent** row below its owning agent message; expand to type/name, task, state and returned summary. Preserve the main agent's final reply. Current running work without a rendered parent answer can appear in that agent's View/progress lane; do not attach it to an arbitrary unrelated message. The PNGs show the chat case only, not a completed implementation of both placements.
4. Reuse existing chat/session authorization. Do not broaden room/guest/Hub access, add child MCP authority, approve tools or create/stop children from this display. Child prompt/result data must be no more visible than the parent conversation; for external Hub/guest projections, keep child details omitted unless their existing authorization explicitly covers them.

**Native/paired Windows limitation:** alpha has `runtime-pane-transcript-protocol.ts` and `runtime-transcript-source.ts`, already fenced to machine/boot/pane/launch/agent/provider and one pinned parent-session cursor. Parent launch/result events may arrive there, but arbitrary child files are not exposed. Full child lifecycle/duration would need an explicitly versioned, bounded runner-owned child observation API with those same fences. No path from coordinator to arbitrary runner filesystem, no new native claim from this Linux-only research. Linux/WSL tmux lane is the smallest first slice; paired support is a separately evidenced extension.

## Static zh-TW proposal

See [screenshots](screenshots/README.md): actual alpha Fleet web shell, 1366×900 desktop/light and 390×844 phone/dark. The private web-only fixture refuses/does not start fleet lifecycle, CLI or tmux. Only synthetic messages are seeded. The proposed read-only disclosure is **DOM-inserted for screenshots**, uses shared style tokens, and has no product import, endpoint, persistence or execution control. Display names are normalized in the proposal to keep the recipient consistent. A page banner says “設計提案｜尚未實作”.

- Claude: one complete and one live child, reflecting the captured intermediate pane.
- Codex: two completed children, collapsed and expanded.
- Unknown: neutral parent text, no invented final result or live timer.

No usage/model/provider/account calls are made by the browser proposal. No product behavior, main/alpha twin, release or merge is requested by this research. Rollback is simply deleting the research branch/artifacts; production files are unchanged.

## Reproduction and checks

The owned raw rig scripts are archived in `.artifacts/m2739/{namespace.py,mock.py,behavior.py,control.py,cleanup.py,export.py}`. Research copies in `scripts/manual/subagent-visibility/rig/` are reference code, not a host CLI probe or one-command installer. Supply the audited binaries explicitly and use a **fresh run root/CODEX_HOME per network namespace**. Keep the full Codex platform package (including code-mode host). Review paths and cleanup before running. Calls must remain inside `unshare -Urn`; never drop isolation to reach a provider.

The mock sends actual advertised Agent/spawn/create_thread tool calls through the real CLIs; do not write fake transcript events as if they were captured. For create_thread's positive control, approve the exact synthetic tool prompt in its private TUI. Save full parent/child bytes and captures before teardown. `cleanup.py` verifies owned daemon PID identity, executable and CODEX_HOME, stops the private tmux/mock, then drains only its exact daemon/updater processes. [cleanup.json](cleanup.json) records private socket closed, mock stopped, all four owned detached processes absent. [ready.json](ready.json) records loopback-only empty routes. Large binaries and scratch credential/config files are excluded from Git.

Focused research verifier: `python3 scripts/manual/subagent-visibility/verify.py`. It checks exported SHA256s, real parent-child joins, completed run durations, refusal-versus-success, and excludes the preliminary mock attempt. This is fixture/evidence validation, not a production feature test. Static screenshots ran in real Chromium; phone/desktop had no horizontal overflow. No full local suite was appropriate for this docs/static-only change.

## Public source pins (read 2026-11-09)

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) and [Claude Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents): current conceptual behavior (separate context, constrained tools/permissions and summaries). SDK stream examples are **not** asserted to be interactive CLI transcript guarantees.
- [OpenAI Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), official redirect from `developers.openai.com/codex/multi-agent`: current subagent workflows and approval behavior. Current docs are not the exact0.167 wire schema; this report uses the pinned binary's captures for that.
- [Codex0.167.0 public npm metadata](https://registry.npmjs.org/@openai%2Fcodex/0.167.0), [Linux x64 platform package metadata](https://registry.npmjs.org/@openai%2Fcodex/0.167.0-linux-x64): downloaded tarballs were checked against their registry SHA512 integrity before extraction; no package install scripts were run. Binary hashes are retained above.
