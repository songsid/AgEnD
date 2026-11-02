# Paired Windows runtimes

This preview lets a native Windows computer connect **outbound** to a central AgEnD coordinator. The computer reports its installed coding CLIs and executes Agents assigned to that machine. Its own CLI login, filesystem, ADB and serial devices stay on that computer. Opening the dashboard from another computer does not provide that browser's local tools.

The coordinator still owns the shared Fleet, Agent settings, task board, delegation, chat and permissions. A runtime owns local processes and a bounded execution journal. An Agent is pinned to its selected machine; a disconnected machine never causes its Agent's prompt to be automatically rerun on another machine.

Design references, source-review scope and bundled license notices are recorded in [Remote Runtime provenance](remote-runtime-provenance.md).

## First connection

Enable the coordinator preview with `AGEND_REMOTE_RUNTIME=1` in the environment used to start AgEnD, then restart it. This flag enables remote Windows Agents even when the coordinator is a Linux machine without Windows interoperability. `AGEND_WINDOWS_CLI=1` remains the separate switch for this coordinator's own local Windows CLI discovery.

1. On the coordinator, open **Settings → Runtimes** and create a pairing code.
2. Click **Download Windows Runtime (ZIP)** on that page. Transfer the ZIP to the Windows computer and extract its `agend-runtime` folder. The package comes from the currently installed AgEnD program, so no repository checkout or build is required. It contains only the runtime modules and reviewed pure-JavaScript `ws` dependency; it does not install the full coordinator, SQLite, Linux native dependencies or a Node binary. Install a supported Windows Node release separately.
3. In a Windows terminal, under the user whose CLIs are installed and signed in, run:

   ```powershell
   .\agend-runtime.cmd connect --server https://your-agend-host --name "Windows desktop"
   ```

4. Enter the one-time code interactively. Do not put the code in command arguments or environment variables. Approve the pending machine in AgEnD Settings. Approval is required before a permanent machine credential is issued.
5. Keep the terminal running. After pairing, `connect` automatically runs the resident client. Press **Ctrl+C** to stop. Later, use `agend-runtime.cmd run` to reconnect the saved profile.
6. In **New Agent**, select the paired machine, its CLI, then configure the Agent. Working directories are paths on that selected computer; leaving the directory empty creates its managed local workspace.

The initial preview runs in the foreground. It does not install an auto-start task or a SYSTEM service. SYSTEM would use a different login, PATH and device permissions from the signed-in Windows user.

The download requires an administrator session on the local dashboard and is unavailable through public gateway links. It includes program assets and license notices only, without pairing codes, machine credentials, CLI sign-ins or workspaces. If installed runtime assets are missing, update or reinstall AgEnD and retry. Developers can also run `npm run build:runtime` after the normal TypeScript build and transfer the resulting `.artifacts/runtime-bundle` folder.

## Network connection

The runtime uses `/runtime/v1/connect` on the same externally reachable AgEnD service as pairing and the dashboard. Remote origins require HTTPS/WSS and a valid certificate. HTTP is accepted only for exact loopback hostnames, for example `http://localhost:19280` through a private SSH forward. The client refuses credential-bearing URLs and redirects.

The existing coordinator listener still binds to loopback. Publishing a new port, changing a firewall or configuring TLS/proxy access is a separate host operation; pairing does not make the listener reachable automatically. A proxy must pass WebSocket upgrades on `/runtime/v1/connect` and POST requests on `/runtime/v1/pair` and `/runtime/v1/claim`. Pairing codes expire after ten minutes and are single-use. The runtime machine credential is unrelated to browser sessions; browser cookies and origins cannot authenticate the runtime channel.

This preview does not open a runtime listener for other computers. Its per-turn MCP relay binds an ephemeral port to **127.0.0.1 only**, and requires a separate random capability for the active execution. It relays scoped AgEnD tool calls over the authenticated outbound runtime connection. The CLI never receives the permanent machine credential. Existing local `/agent` restrictions remain in place.

## Connecting over a private network

### Tailscale Serve (recommended for another computer)

Install and sign in to Tailscale on the coordinator host and the Windows runtime computer, using an approved tailnet. The runtime computer also needs the Windows Node.js installation and CLI sign-ins described above. Enable HTTPS certificates for the tailnet when prompted by Tailscale. Serve provides a valid certificate for the host's `https://<host>.<tailnet>.ts.net` address; tailnet access rules still control which devices may reach it. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

1. On the coordinator host, verify that `http://127.0.0.1:19280/ui` reaches AgEnD locally. If AgEnD runs in WSL, run this check and Tailscale Serve on the **Windows host**. Windows can normally reach a WSL application through localhost, but verify this on the actual machine before configuring Serve; WSL networking mode, localhost forwarding and host configuration can affect reachability. Keep AgEnD bound to loopback while resolving that local connection. See [Microsoft's WSL networking guidance](https://learn.microsoft.com/en-us/windows/wsl/networking).
2. Inspect existing mappings with `tailscale serve status` **before** adding a proxy. Do not overwrite an HTTPS port or root mapping that already serves another application. The example below assumes port 443 is unused; otherwise choose an unused HTTPS port, substitute it in `--https`, and include that port in the runtime's server origin (for example, `https://coordinator.example-tailnet.ts.net:8443` if 8443 is free). Then proxy the AgEnD origin from a coordinator terminal:

   ```powershell
   tailscale serve --https=443 http://127.0.0.1:19280
   ```

   Leave this foreground command running. In another terminal, use `tailscale serve status` to verify the HTTPS hostname, selected port and root `/` proxy target. These commands follow the [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
3. On the other Windows computer, enter the extracted Runtime folder and use the exact HTTPS origin printed by Serve:

   ```powershell
   .\agend-runtime.cmd connect --server https://coordinator.example-tailnet.ts.net
   ```

   Enter the pairing code interactively and approve that computer from the local AgEnD administrator dashboard. Keep the Runtime terminal running too.
4. Stop the foreground Serve command with **Ctrl+C** when sharing is no longer needed. An operator can also remove this HTTPS mapping with `tailscale serve --https=443 off`; substitute the original HTTPS port if changed. Avoid resetting unrelated Serve mappings.

**Never use `tailscale funnel` for this setup.** Funnel publishes the service to the internet; Serve is intended for access within the tailnet. Tailnet membership and its access rules become part of the trust boundary for the reachable pairing/claim endpoints. Admit only intended devices and users, and retain AgEnD's single-use code, local administrator approval and machine-credential checks. Tailscale identity headers do not replace AgEnD authentication.

Mount the origin at `/`, without rewriting paths. The proxy must preserve both JSON POSTs (`/runtime/v1/pair` and `/runtime/v1/claim`) and the HTTP/1.1 WebSocket upgrade (`/runtime/v1/connect`), including the runtime's Authorization header. Verify a complete pairing/approval/claim and an online Runtime connection through the chosen proxy; loading the dashboard alone does not establish that the WebSocket path works. Record the Tailscale version and confirm that the connection remains online, including a reconnect, when validating an actual tailnet deployment. Automated proxy tests do not by themselves certify a particular Tailscale installation or its access policy.

### SSH local forward

With an SSH server and account already configured on the coordinator, open this forward **from the Windows runtime computer**:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:19280:127.0.0.1:19280 user@coordinator
```

The first loopback address binds the forwarded port only on the runtime computer; the second is reached from the SSH server's host. `-N` runs the forward without a remote command, and `ExitOnForwardFailure` stops SSH if it cannot establish the requested listener. See the [OpenSSH client manual](https://man.openbsd.org/ssh) and [forwarding configuration](https://man.openbsd.org/ssh_config#ExitOnForwardFailure). For a WSL coordinator, choose an SSH endpoint from which AgEnD's loopback port is reachable. Keep the SSH terminal open. In another terminal, inside the Runtime folder, run:

```powershell
.\agend-runtime.cmd connect --server http://localhost:19280
```

Enter the pairing code and approve the machine as above. This HTTP origin meets the runtime's loopback rule; SSH encrypts the traffic between computers. If port 19280 is already used on the runtime computer, choose another **local** port in `-L` and use that port in `--server`. Stop the Runtime and SSH commands with **Ctrl+C** when finished.

**Plain HTTP to a LAN or tailnet IP address is refused deliberately**, including `http://192.168.1.20:19280`. On an ordinary LAN, HTTP would send the pairing code and permanent machine credential in cleartext, allowing interception or impersonation of the coordinator. The client keeps its HTTPS-origin requirement even when a private network provides separate transport encryption. Use a valid HTTPS origin or the loopback SSH-forward path. This preview does not accept a self-signed certificate or implement certificate fingerprint pinning; that is a possible follow-up, not a prerequisite for these two paths.

## Inventory and models

Pairing and reconnecting establish the runtime connection without launching CLI discovery. After approving a newly paired computer, open **Settings → Runtime** and click that computer's **Refresh CLI inventory** button to run detection explicitly. Until a successful detection has been saved, the computer can be online while its CLI list is empty. Local Windows CLI detection likewise requires an explicit administrator action in the local diagnostics.

Agent creation, CLI selectors and native model selectors read the last successful saved inventory. Opening those screens, refreshing a model selector through a GET request, connecting or reconnecting a runtime, and starting a task do not run CLI discovery. There is no periodic background detection. Use **Refresh CLI inventory** after installing, removing, updating or signing in to a CLI; refreshing the machine list only reloads the coordinator's saved machine information.

Successful detection saves the CLI inventory and its update time for subsequent reads and reconnects. A failed or incomplete detection retains the previous successful inventory. Detection reports versions, login availability and model list provenance, without reading or uploading CLI login tokens.

The Runtime's private inventory file is the local execution gate. If that file is removed or corrupted, the Runtime reports an empty, never-detected inventory and requires a new explicit detection; it does not restore runnable capabilities from an older central snapshot. The machine card's inventory update timestamp records the latest central synchronization. The inventory's `probedAt` records when detection actually ran, so reconnecting and republishing a cached list is not a new detection.

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
