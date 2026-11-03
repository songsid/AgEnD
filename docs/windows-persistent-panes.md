# Persistent Windows agents (alpha)

This adapter is opt-in on the **2.3.5 alpha line**. The existing per-turn **exec** adapter remains the default. The coordinator still runs in WSL/Linux; Codex or Claude Code runs in a long-lived native Windows ConPTY on this PC or a paired Windows PC. Each agent owns its own pane and exact saved conversation. No tmux server runs on Windows.

## Choose an adapter

Enable the appropriate switch in **Settings → Runtime**: **Use this PC's Windows CLIs** for this PC, or **Allow other Windows PCs to pair** for a paired runtime. Explicitly detect the CLIs on that machine. In **New agent → Native Windows**, choose **Persistent terminal (alpha)** for Codex or Claude Code. Review the workspace, file-access policy and destination shown in the administrator's confirmation. Creation reserves the profile, instance and topic together; an unconfirmed cleanup keeps them held together.

The initial audited releases are **Codex 0.165.0** and **Claude Code 2.1.316**. Other versions are refused for this adapter, including a newer release discovered between inventory detection and launch. Immediately before starting a pane, its owned helper runs a bounded version-only check with self-update disabled. This is separate from administrator-triggered inventory detection: no sign-in check, model discovery or account synchronization runs at launch. Update the inventory after an intentional CLI update; a new release also needs adapter acceptance before use.

The config representation is:

```yaml
runtimes:
  windows_cli: true
  remote_runtime: false
  max_agents_per_machine: 4
instances:
  example:
    runtime: windows
    native_agent_id: "<existing native profile UUID>"
    native_adapter: pane
    native_sandbox: read-only
```

Create the profile through the approved New agent flow rather than inventing a profile UUID. Omitting `native_adapter`, or setting it to `exec`, selects the existing per-turn adapter. Imported/YAML profiles do not automatically create external topics. Persistent-pane creation binds the destination in its administrator approval; it never silently chooses another General connection after approval.

**Concurrent Windows agents per machine** is an integer from 1 to 16, default **4**. It applies separately to this PC and each paired PC, including their active exec work and persistent panes. Lowering it blocks new starts until the count falls; it does not stop existing agents. Unknown process outcomes count against admission. Persistent agents do not share a fleet-wide single slot. The exec adapter retains its existing per-turn scheduling and five-minute limit.

## Messages and permissions

Persistent agents use the ordinary instance daemon, topic/chat, delivery outbox, reply guard, progress and Needs-you paths. Captures come from a headless terminal; tool/turn evidence comes from the exact owned native provider session. AgEnD does not choose the newest conversation in a folder. Resume retains the pinned session ID and never uses `--last` or silently starts fresh after a failure.

Normal permission dialogs retain the provider's policy and require the existing administrator/human-control authority. A button is bound to the current instance, pane, launch and interaction; it cannot authorize a replacement pane. Codex uses its native sandbox and on-request approvals. Claude read-only exposes Read/Glob/Grep and scoped AgEnD query tools; **it is a tool policy, not an operating-system sandbox**. Claude workspace access uses `acceptEdits` and a launch-local `blockWritesOutsideWorkingDirectories` file-tool check, without `--add-dir` or a permission bypass. Both adapters pass `--setting-sources ""`: user, project and local settings (including additional directories and allow rules) are excluded for these launches; their files are never rewritten. Managed organization policy still applies. Shell and MCP tools have separate policies; this is not an OS sandbox. A Windows Job Object and private filesystem ACL establish process ownership and private state; they are not a filesystem or network sandbox.

Each invocation receives its own role instructions and scoped AgEnD MCP connection. It does not rewrite shared project instructions, copy Windows credentials into WSL, change the user's account configuration, or use the coordinator's signed-in provider account. Codex runs with `--no-daemon`. Only its exact configured AgEnD helper is preapproved; other tool approvals keep the provider policy.

Alpha limitations: native attachment/file-transfer tools and reasoning-effort controls are unavailable and explicitly refused. Provider usage reporting is not supplied by this adapter. Agent-initiated creation from chat is a separate integration from the approved New agent flow. An unfamiliar terminal dialog or unsupported layout holds delivery rather than guessing keys. Native input is bound to a verified composer or explicit dialog screen and its received-output sequence; a repaint refuses that command without replay. Automatic Claude trust steps also require the displayed path to match the configured cwd exactly.

## Disconnect, stop and recovery

- A coordinator restart, WebSocket reconnect, or foreground runtime-client exit detaches the connection and preserves resident panes. Reattachment requires the same authenticated host/pane/launch/profile identities. Pending MCP authority is invalidated while disconnected. Reconnect does not repeat Enter, paste or an uncertain tool mutation.
- **Stop** closes the exact owned job and waits for its positive exit receipt. Crash recovery reconciles the previous delivery before releasing authority and resuming the same session with a bounded crash budget. Repeated crashes hold the agent; manual restart does not erase its conversation.
- Host death or an unconfirmed exit retains a durable reservation. Neither a missing PID nor a missing connection proves that the CLI stopped. AgEnD does not adopt a process by PID, clear the hold automatically, or fall back to exec.
- Turning a runtime switch off fences new input/MCP immediately and drains its exact owned panes. An offline or unconfirmed pane remains held. Turning the switch back on cannot bypass an unfinished drain.
- **Revoke machine** retires that enrollment's exact owned pane jobs and invalidates its credential. Ordinary disconnect and connection replacement only detach. If the runner is offline or cannot prove retirement, central reservations remain held; revocation is not a false stopped receipt.

Pane commands use a closed operation set, identity checks and durable operation/sequence records. The runtime channel has no arbitrary executable, argv, environment or shell-command RPC. Bounded transport/output queues apply backpressure; raw diagnostics rotate and transcript gaps are explicit rather than presented as complete history.

## Roll back to exec

1. Stop the persistent agent and wait for confirmed owned exit. If its outcome is unknown, inspect and resolve the held launch first; do not create another adapter for it.
2. Keep the native profile, exact conversation ID, journals and instance/topic. Change only that instance's `native_adapter` from `pane` to `exec` in `fleet.yaml`, then reload the config.
3. Send a small continuation through the existing exec path, which uses the same profile's saved conversation ID. The provider still has to support that conversation and its normal exec command. Reverting to pane follows the same stop-first rule.

There is no simultaneous-adapter takeover, automatic fresh conversation, profile deletion or account-store rewrite in this rollback.

## Packaging and acceptance limits

The runtime ships pinned node-pty ConPTY prebuilds for Windows x64 and ARM64 with a headless terminal. Release assembly checks hashes, native PE architecture and the module closure. Native Windows x64 is exercised; ARM64 packaging checks do not substitute for a real ARM64 run. Installation never builds a native module on the person's PC.

Private staging verifies an immutable bundle before launch and uses bounded retries for antivirus/file-lock interference. Slow startup has a deadline and a retained outcome, not a second untracked CLI. Measured scratch launches include normal antivirus behavior without changing Defender or flushing caches; they are not a guarantee for another machine.

See [local Windows setup](windows-cli-preview.md) and [paired runtimes](remote-runtime.md). Manual acceptance harnesses and their privacy constraints are documented in `scripts/manual/windows-pane-adapter/README.md`.
