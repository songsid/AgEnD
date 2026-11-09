# Reference rig: captured M-2739 campaign

Research helpers only. These copies describe the exact campaign; they are not production probes. Full package artifacts are deliberately not committed. The campaign used Claude2.1.319 and Codex0.167.0 verified binary hashes in the research manifest. Only model APIs are mocked; the CLIs actually create/run their children.

`namespace.py` is the bounded controller, `mock.py` serves local Messages/Responses, `behavior.py` chooses deterministic tool calls/final text with delays. `control.py` sends a single owned tmux action; `cleanup.py` drains the controller and its exact pidfile-owned Codex daemons. `export.py` is the **original campaign-specific extraction** (fixed IDs/path layout), not a generic transcript parser: don't run it against arbitrary homes.

Use a new scratch root for every namespace; never reuse a CODEX_HOME while a previous daemon is alive. Keep scripts separately from downloaded archives. The binaries require execute permission; keep Codex's platform package/companions intact. No API key, login or provider URL is needed. `namespace.py` generates a fake Anthropic key accepted only by its own mock. CLI flags are recorded in the controller inputs, including strict empty external MCP config and Read-only Claude child tools. It does not modify any real CLI configuration.

Example controller launch after reviewing the script and setting paths:

```sh
export AUDIT_RUN_ROOT="<new-owned-run-directory>"
export AUDIT_CODEX_BIN="<owned-full-platform-package>/bin/codex"
export AUDIT_CLAUDE_BIN="<owned-audited-claude>"
mkdir -p "$AUDIT_RUN_ROOT/ctl"
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$AUDIT_RUN_ROOT/ctl" \
 AUDIT_CODEX_BIN="$AUDIT_CODEX_BIN" AUDIT_CLAUDE_BIN="$AUDIT_CLAUDE_BIN" \
 unshare -Urn python3 scripts/manual/subagent-visibility/rig/namespace.py "$AUDIT_RUN_ROOT"
```

The command runs in the foreground; use a separate owned orchestration session to issue actions after `ready.json`. Assert `routes:[]` and loopback only. Never replace `unshare -Urn` with a host launch. Creating a private **user+network namespace** is not a VM/filesystem jail; use a synthetic cwd and no real credentials. All CLI controls target the explicit private socket, never default tmux.

Before launch write `<run>/modes.json` with `{"claude":"spawn","codex":"spawn"}`. Launch through `control.py` using the captured flags from research/namespace receipts. For Claude, custom reader/checker subagent definitions both permit only `Read`; the prompt asks each to inspect a different synthetic marker. Create `work/marker-one.txt` and `work/marker-two.txt` containing innocuous text first. For Codex, `--no-alt-screen -a never -s read-only` and the `multi_agent_v1` mock produce two child threads. Wait for TUI startup before sending the prompt; an early Enter can be consumed by startup. Use explicit ready frames rather than arbitrary model assumptions.

For the separate-task case set codex mode to `threads`, launch a **fresh** parent TUI. `-a never` demonstrates the real refusal. The positive case uses `-a on-request`; inspect and approve only the exact synthetic `codex_tui.create_thread` prompt in that owned TUI, no generic approvals. The mock recognizes the CLI's `codex_delegation` tool-output input so the created task returns plain text rather than recursively delegating. No shell calls are returned by the mock.

Save parent, sidechain/child rollout bytes and captures before teardown. For control captures use safe owned filenames only; these reference helpers are not an untrusted network API. For teardown call `AUDIT_RUN_ROOT=… python3 …/cleanup.py`, which touches the stop sentinel and verifies exact executable/CODEX_HOME/PID start identity before signalling retained daemons. Do **not** use the control action `stop` as an acknowledged action: the controller exits before appending its acknowledgement. Cleanup receipts are the proof. Never use broad pkill, a live socket or another instance's checkout.
