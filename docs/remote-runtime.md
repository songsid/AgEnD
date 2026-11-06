# Paired Windows runtimes

繁體中文：[連接電腦與一行安裝](remote-runtime.zh-TW.md)（連接流程與 Windows 一行安裝；其餘章節目前只有英文）。

The default adapter remains per-turn **exec**. For the 2.3.5 alpha line's opt-in persistent Codex/Claude panes, see [Persistent Windows agents](windows-persistent-panes.md) ([繁體中文](windows-persistent-panes.zh-TW.md)). Its disconnect/stop/revocation rules replace the exec-only lifecycle below; ordinary runtime-client exit preserves those resident panes.

This preview lets a native Windows computer connect **outbound** to a central AgEnD coordinator. The computer reports its installed coding CLIs and executes Agents assigned to that machine. Its own CLI login, filesystem, ADB and serial devices stay on that computer. Opening the dashboard from another computer does not provide that browser's local tools.

The coordinator still owns the shared Fleet, Agent settings, task board, delegation, chat and permissions. A runtime owns local processes and a bounded execution journal. An Agent is pinned to its selected machine; a disconnected machine never causes its Agent's prompt to be automatically rerun on another machine.

Design references, source-review scope and bundled license notices are recorded in [Remote Runtime provenance](remote-runtime-provenance.md).

## Runtime version reports

Current runtimes report their own package version, code Build ID, supported protocol versions and transport capabilities when connecting. Open a computer card's **Computer information** menu to inspect them. `agend-runtime --version` prints the same installation's information without connecting or reading its private profile; `status` includes it alongside profile status.

The code Build ID hashes the installed fixed runtime modules (including the pane helper scripts) and package version. It distinguishes different program builds carrying the same alpha version; it is not a signature or the downloadable ZIP's SHA-256, and excludes user profiles, CLI installations and runtime dependencies. An incomplete program installation has no Build ID. Unreadable package metadata remains unknown instead of using the coordinator's version.

Older runtimes keep connecting over protocol v1 and show **This Runtime does not provide version information**. Replace the portable program folder once and reconnect the existing profile to enable reporting. There is no automatic update or remote installation in this change. Protocol compatibility is diagnostic metadata based on the reported supported protocols; it does not change existing wire validation, execution authorization or pane negotiation. Reported capabilities grant no permissions. Reconnecting with an older client clears the prior connection's version report.

## CLI diagnostics on a selected computer

In **Settings → Runtime**, the host's Windows installation and approved paired computers use the same machine cards. Each card shows detected CLIs, versions and sign-ins. Click **CLI diagnostics** on a card to open a dialog fixed to that computer. Paired-computer diagnostics also work when the coordinator has no local Windows CLI support.

Opening the dialog reads saved inventory. **Detect Windows CLIs** explicitly refreshes that computer only. Expand a CLI row for its executable path and reported models. Expand **Test CLI** for the optional one-off task form and results; it starts collapsed until a test is active. Closing the dialog does not cancel submitted work; reopen the same computer to read its task status. Working directories, models and drafts stay separate for each computer. Offline computers show saved inventory with detection and dispatch disabled. Revocation never moves diagnostics to another computer.

Test tasks use the existing per-turn execution protocol and task journal. An unconfirmed acknowledgement remains visible and blocks another task until the Runtime reconciles its outcome; reopening the panel never replays the request.

## First connection

Turn on **Allow other Windows PCs to pair** in **Settings → Runtime** (fleet.yaml `runtimes.remote_runtime: true`; off by default). Turning it on asks a fleet admin to confirm, like other access settings; it applies without a restart. This machine stays your fleet; the other PC runs only the small runner below, never a fleet. Remote Windows agents work even when this machine is a Linux machine without Windows interoperability. **Use this PC's Windows CLIs** (`runtimes.windows_cli`) is the separate switch for this machine's own Windows CLIs.

Turning the switch off fences new work immediately and keeps machine approvals. Persistent panes drain through confirmed owned cleanup; offline or unconfirmed outcomes remain held. **Agents at once on each Windows PC** (`runtimes.max_agents_per_machine`, 1–16, default 4) limits each PC separately. Lowering it blocks new starts without stopping existing agents.

The environment variable `AGEND_REMOTE_RUNTIME` still overrides the setting: `1` forces it on and `0` forces it off (Settings then shows "Set by the environment" and cannot change it). Any other value, or none, leaves it to Settings.

1. On the coordinator, open **Settings → Runtime → Connect a computer**.
2. Review the **AgEnD address** that the other computer can reach. The page starts with the browser's origin; replace localhost with your existing reachable HTTPS origin unless the other computer has a loopback tunnel. This does not configure a proxy or change network access.
3. Choose how the other computer gets the Runtime, in the tabs under the address:
   - **Windows (PowerShell)**: copy the **install command**, paste it into PowerShell on the other Windows computer, then copy the **connect command** and run it there. See [One-line install](#one-line-install-windows-powershell).
   - **Other install methods (ZIP)**: click **Download Windows Runtime (ZIP)**. This authenticated download includes the reviewed public origin in `agend-server.json` and a `connect-agend.bat` launcher. No pairing code, browser token or machine credential is embedded. The address is read as JSON, never interpolated into a batch command. Transfer the ZIP to the Windows computer, extract it, and double-click **connect-agend.bat**.
4. Run it under the Windows user whose CLIs are installed and signed in. A supported Windows Node.js installation is required with either method. The Runtime prints the destination before asking for a pairing code.
5. On first connection, enter the one-time code from Settings. Compare the **Pairing fingerprint** printed in the Runtime terminal with the fingerprint on the machine card, then approve it in AgEnD. Keep the terminal running. If AgEnD ends the connection (the computer was revoked or is not recognised, another Runtime took over the same pairing, or AgEnD rejected a message), the window stays open with the reason and the next step, and the exit code is non-zero; stopping with Ctrl+C is the only silent exit. If it says the profile still holds an unfinished job from another pairing, check that no CLI that job started is still running, delete `jobs.json` in the profile folder as the message says, and pair again. An existing profile paired with the same origin reconnects without asking for another code; a profile paired with another origin is never reused or sent to the new server. With a connection-ready ZIP, `connect-agend.bat` keeps that profile untouched and pairs a separate one under `%USERPROFILE%\.agend-runtime\profiles\<host>-<port>`; the same bat, and `run`, `status`, `rotate` and `disconnect` started from that folder, find it again. Without `agend-server.json`, or when you choose one yourself with `--profile DIRECTORY` or `AGEND_RUNTIME_HOME` (which always wins), the command fails and names both addresses; keep both with a separate `--profile` and pass the same `--profile` to every later `run`, `status`, `rotate` and `disconnect`.
6. In Settings, explicitly detect this computer's CLI inventory when needed. Connecting alone starts no CLI discovery.

The manual command remains available under **Manual connection command**:

```powershell
.\agend-runtime.cmd connect --server https://your-agend-host --name "Windows desktop"
```

`run` still reconnects a saved profile. Connection defaults never replace its credential or retarget it to another server. Generic packages without `agend-server.json` keep supporting the explicit `--server` command. The connection-ready download uses an administrator POST with the existing same-origin and CSRF protections; GET download URLs cannot embed a caller-selected server.

The ZIP download from Settings requires an administrator session on the local dashboard and is unavailable through public gateway links; the one-line install routes above are separate, public and read-only. It includes program assets, license notices and, for a connection-ready download, the administrator-selected public server origin. It excludes pairing codes, machine credentials, CLI sign-ins and workspaces. If installed runtime assets are missing, update or reinstall AgEnD and retry. Developers can also run `npm run build:runtime` after the normal TypeScript build and transfer the resulting `.artifacts/runtime-bundle` folder.

## One-line install (Windows PowerShell)

**Settings → Runtime → Connect a computer → Windows (PowerShell)** shows two commands with the address you confirmed in step 1. Run the first on the other Windows computer, in PowerShell as the Windows user whose CLIs are installed. No administrator rights are needed.

```powershell
$agend = 'https://your-agend-host'; irm "$agend/runtime/install.ps1" | iex
```

It installs the Runtime and prints the next command. It does **not** connect and does **not** pair:

```powershell
agend-runtime connect --server "https://your-agend-host"
```

The one-time pairing code is typed into that terminal when it asks, never put in either command. Then compare the **Pairing fingerprint** and approve the computer in AgEnD exactly as in [First connection](#first-connection). The ZIP flow is unchanged and remains under **Other install methods (ZIP)**.

What the install command does, in order:

1. Checks that Node.js 22.14 or newer (22.14+, 23.6+ or 24+) is installed. If not, it stops and shows `winget install OpenJS.NodeJS.LTS` or nodejs.org. It never installs software for you.
2. Downloads the Runtime archive from `$agend` (one bounded request, redirects refused, at most 16 MiB).
3. Computes the archive's SHA-256 itself and compares it with the checksum written inside the installer script. On a mismatch it stops before anything is unpacked.
4. Unpacks into `%LOCALAPPDATA%\agend-runtime\<version>` and writes `agend-runtime.cmd` to `%LOCALAPPDATA%\agend-runtime\bin`.
5. Adds that `bin` folder to **your user PATH** (registry `HKCU`, not the machine PATH).
6. Prints the connect command.

It deletes only its own staging folder and a folder of the same version it is replacing. Running it again with the same server version changes nothing; a newer server version installs into a new version folder and repoints `agend-runtime.cmd`. Earlier version folders stay until you delete them. There is still no automatic update. If it fails it says why and sets `$LASTEXITCODE` to 1.

Optional variables, set in the same PowerShell window before the command:

| Variable | Effect |
|---|---|
| `AGEND_RUNTIME_NO_PATH=1` | Leave PATH alone. The final message then shows the full path of `agend-runtime.cmd` to run. |
| `AGEND_RUNTIME_INSTALL_DIR=D:\agend` | Install under this folder (a full drive path) instead of `%LOCALAPPDATA%\agend-runtime`. |

### What the server serves

Two read-only GET routes, next to the pairing endpoints, need no sign-in:

| Route | Content |
|---|---|
| `/runtime/install.ps1` | The installer script, with this server's runtime version and the archive's SHA-256 written into it. |
| `/runtime/v1/bundle/windows.zip` | The generic Runtime archive: the same `createRuntimeBundle()` output Settings downloads, without `agend-server.json`. |

They are served only while **Allow other Windows PCs to pair** is on (otherwise both answer `404`, exactly like an unknown route), never through a public gateway link (`404` there too), and only over HTTPS or loopback. The usual Host allow-list still applies. Requests are rate limited per address and in total, and the archive can never exceed the bundle's 8 MiB cap.

Both are **static for a server version**: the generic bundle is built once per server process and kept, so its hash is stable, and the script is that bundle's version and SHA-256 inside a fixed template. Nothing in a response depends on the request: not the Host header, a query (a query is refused), a cookie or the caller. The script carries no token, secret, pairing code or server address; the address comes from `$agend` in the command. The checksum is pinned inside the script, not read from the archive's own response, so a script fetched over TLS from the right server will refuse any other archive. Downloading the installer grants no authority: pairing (one-time code, ten-minute expiry, fingerprint, local administrator approval) is unchanged, and an unapproved computer can do nothing.

The checksum protects against a damaged or substituted archive after the script was fetched. It does not prove where the script came from: trust in the script is trust in the server's HTTPS origin, as with the ZIP.

### Remove it

Disconnect the profile and delete the program folder, then remove its `bin` folder from your user PATH (Windows **Settings → System → About → Advanced system settings → Environment Variables**, user variable `Path`):

```powershell
agend-runtime disconnect
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agend-runtime"
```

The profile (`%USERPROFILE%\.agend-runtime` by default) is separate and stays until you delete it. Revoke the computer in AgEnD Settings to invalidate its credential centrally.

## Network connection

The runtime uses `/runtime/v1/connect` on the same externally reachable AgEnD service as pairing and the dashboard. Remote origins require HTTPS/WSS and a valid certificate. HTTP is accepted only for exact loopback hostnames, for example `http://localhost:19280` through a private SSH forward. The client refuses credential-bearing URLs and redirects.

The existing coordinator listener still binds to loopback. Publishing a new port, changing a firewall or configuring TLS/proxy access is a separate host operation; pairing does not make the listener reachable automatically. A proxy must pass WebSocket upgrades on `/runtime/v1/connect` and POST requests on `/runtime/v1/pair`, `/runtime/v1/claim` and `/runtime/v1/rotate`. The one-line install also needs GET on `/runtime/install.ps1` and `/runtime/v1/bundle/windows.zip`. Pairing codes expire after ten minutes and are single-use. The runtime machine credential is unrelated to browser sessions; browser cookies and origins cannot authenticate the runtime channel.

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

Mount the origin at `/`, without rewriting paths. The proxy must preserve both JSON POSTs (`/runtime/v1/pair`, `/runtime/v1/claim` and `/runtime/v1/rotate`) and the HTTP/1.1 WebSocket upgrade (`/runtime/v1/connect`), including the runtime's Authorization header. Verify a complete pairing/approval/claim and an online Runtime connection through the chosen proxy; loading the dashboard alone does not establish that the WebSocket path works. Record the Tailscale version and confirm that the connection remains online, including a reconnect, when validating an actual tailnet deployment. Automated proxy tests do not by themselves certify a particular Tailscale installation or its access policy.

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

The default Windows profile inherits the user's profile ACL; POSIX mode bits do not enforce Windows privacy. A custom profile directory must already have an appropriate private ACL; this preview does not harden a custom directory. **The machine credential is not encrypted by this preview.** Do not share or synchronize the runtime profile. Existing CLI authentication files are not modified.

```powershell
.\agend-runtime.cmd status
.\agend-runtime.cmd disconnect
```

`status` prints machine identity and job states, without the credential or prompts. Stop the foreground client before `disconnect`; it forgets the local connection. To invalidate a credential centrally, **revoke the machine in AgEnD Settings**. Revoke rejects new runtime connections and closes an existing connection. Local process shutdown remains subject to the explicit completion/cancellation rules above.

## Rotate a machine credential without pairing again

Stop the foreground runtime with **Ctrl+C**, then, in the same extracted Runtime folder and under the same Windows user, run:

```powershell
.\agend-runtime.cmd rotate
.\agend-runtime.cmd run
```

Pass the same `--profile DIRECTORY` to both commands if you use a non-default profile. A profile that a connection-ready ZIP created under `profiles\<host>-<port>` is found automatically when you run the commands from that folder. Rotation refuses while that profile is in use; it never stops an execution automatically. It keeps the machine identity, approval, inventory and job journal. Once the coordinator commits the rotation, the previous credential can no longer connect. Neither credential appears in command arguments or status output.

The replacement is saved privately in `connection.json` before the request. If a response is lost or the final local save fails, keep the profile intact and retry `rotate`, or use `run` to finish the saved rotation before connecting. `status` reports `rotationPending` without the credential. Do not downgrade or delete the saved candidate while rotation is pending. A revoked machine cannot rotate itself back into authorization. Anyone holding the current credential can request a rotation, so rotation is not recovery from credential theft; revoke a compromised machine.

Valid pairing codes, claims and rotations have independent rate-limit buckets even when a proxy or SSH forward makes every connection appear to come from loopback. Invalid traffic has a separate bounded bucket; forwarding headers do not grant identity or bypass limits. The comparison fingerprint is not a password or a replacement for HTTPS and administrator approval.
