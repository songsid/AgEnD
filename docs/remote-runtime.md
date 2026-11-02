# Paired Windows runtimes

This preview lets a native Windows computer connect **outbound** to a central AgEnD coordinator. The computer reports its installed coding CLIs and executes Agents assigned to that machine. Its own CLI login, filesystem, ADB and serial devices stay on that computer. Opening the dashboard from another computer does not provide that browser's local tools.

The coordinator still owns the shared Fleet, Agent settings, task board, delegation, chat and permissions. A runtime owns local processes and a bounded execution journal. An Agent is pinned to its selected machine; a disconnected machine never causes its Agent's prompt to be automatically rerun on another machine.

## First connection

Enable the coordinator preview with `AGEND_REMOTE_RUNTIME=1` in the environment used to start AgEnD, then restart it. This flag enables remote Windows Agents even when the coordinator is a Linux machine without Windows interoperability. `AGEND_WINDOWS_CLI=1` remains the separate switch for this coordinator's own local Windows CLI discovery.

1. On the coordinator, open **Settings → Runtimes** and create a pairing code.
2. Build the standalone runtime with `npm run build:runtime` after the normal TypeScript build. Copy the resulting `.artifacts/runtime-bundle` folder to the Windows computer. It contains only the runtime modules and reviewed pure-JavaScript `ws` dependency; it does not install the full coordinator, SQLite, Linux native dependencies or a Node binary. Install a supported Windows Node release separately.
3. In a Windows terminal, under the user whose CLIs are installed and signed in, run:

   ```powershell
   .\agend-runtime.cmd connect --server https://your-agend-host --name "Windows desktop"
   ```

4. Enter the one-time code interactively. Do not put the code in command arguments or environment variables. Approve the pending machine in AgEnD Settings. Approval is required before a permanent machine credential is issued.
5. Keep the terminal running. After pairing, `connect` automatically runs the resident client. Press **Ctrl+C** to stop. Later, use `agend-runtime.cmd run` to reconnect the saved profile.
6. In **New Agent**, select the paired machine, its CLI, then configure the Agent. Working directories are paths on that selected computer; leaving the directory empty creates its managed local workspace.

The initial preview runs in the foreground. It does not install an auto-start task or a SYSTEM service. SYSTEM would use a different login, PATH and device permissions from the signed-in Windows user.

## Network connection

The runtime uses `/runtime/v1/connect` on the same externally reachable AgEnD service as pairing and the dashboard. Remote origins require HTTPS/WSS and a valid certificate. HTTP is accepted only for exact loopback hostnames, for example `http://localhost:19280` through a private SSH forward. The client refuses credential-bearing URLs and redirects.

The existing coordinator listener still binds to loopback. Publishing a new port, changing a firewall or configuring TLS/proxy access is a separate host operation; pairing does not make the listener reachable automatically. A proxy must pass WebSocket upgrades on `/runtime/v1/connect` and POST requests on `/runtime/v1/pair` and `/runtime/v1/claim`. Pairing codes expire after ten minutes and are single-use. The runtime machine credential is unrelated to browser sessions; browser cookies and origins cannot authenticate the runtime channel.

This preview does not open a runtime listener for other computers. Its per-turn MCP relay binds an ephemeral port to **127.0.0.1 only**, and requires a separate random capability for the active execution. It relays scoped AgEnD tool calls over the authenticated outbound runtime connection. The CLI never receives the permanent machine credential. Existing local `/agent` restrictions remain in place.

## Inventory and models

The runtime connects before discovery finishes, so the coordinator can show a connected machine and a loading status. An incomplete discovery never overwrites the coordinator's last successful inventory. Discovery reports versions, login availability and model list provenance, without reading/uploading CLI login tokens. Manual refresh is supported; an online idle runtime refreshes its inventory in the background every five minutes.

Only installed, execution-compatible CLIs are selectable. Each CLI retains its normal approval and sandbox policy. No `--yolo`, blanket approval or sandbox bypass is added. A provider that cannot enforce read-only execution must use its explicitly selected native permission mode. Installing a runtime does not make every local tool safe or available without the CLI's normal permissions.

## Disconnects, cancellation and recovery

- Accepted execution identity is saved **before** starting a child process. Repeating the same ID and arguments returns the original snapshot; changed arguments under the same ID are refused.
- During a short connection loss, the runtime retains the child process and its bounded output. It reconnects with exponential backoff and jitter, capped at thirty seconds. Reconnection replays snapshots; it never relaunches a prompt automatically.
- If the connection remains down for forty-five seconds, cancellation is requested for the active execution. A cancellation request is not proof of stopped processes. The terminal status is reported only when the worker confirms completion or shutdown.
- After a runtime crash/restart, an unfinished execution is marked **unknown** and blocks new work. Check its Windows processes and use the explicit recovery action after confirming they stopped. Recovery clears the block; it never reruns that execution.
- AgEnD MCP authority is checked centrally for each execution and tool. A disconnected or revoked execution does not gain a new MCP grant simply because it reconnects.
- Each runtime currently has one execution slot and retains the existing native worker's five-minute execution limit. The journal retains 128 recent snapshots and 4,096 used execution identities; old identities cannot be silently reused after snapshots expire.

## Private state and removal

The default local profile is `%USERPROFILE%\.agend-runtime`; `--profile DIRECTORY` or `AGEND_RUNTIME_HOME` selects another private profile. `connection.json` contains the permanent machine credential, and `jobs.json` contains bounded result snapshots and argument hashes. The runtime does not save a separate input-prompt field or provider login credentials in that journal. A CLI result can quote its input, so treat result snapshots as private too. The CLI itself may retain its ordinary local conversation history.

Files are created privately under the user's profile. **The machine credential is not encrypted by this preview.** Do not share or synchronize the runtime profile. Existing CLI authentication files are not modified.

```powershell
.\agend-runtime.cmd status
.\agend-runtime.cmd disconnect
```

`status` prints machine identity and job states, without the credential or prompts. Stop the foreground client before `disconnect`; it forgets the local connection. To invalidate a credential centrally, **revoke the machine in AgEnD Settings**. Revoke rejects new runtime connections and closes an existing connection. Local process shutdown remains subject to the explicit completion/cancellation rules above.
