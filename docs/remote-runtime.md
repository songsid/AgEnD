# Paired Windows runtimes

繁體中文：[連接電腦與一行安裝](remote-runtime.zh-TW.md)（連接流程與 Windows 一行安裝；其餘章節目前只有英文）。

The default adapter remains per-turn **exec**. For the 2.3.5 alpha line's opt-in persistent Codex/Claude panes, see [Persistent Windows agents](windows-persistent-panes.md) ([繁體中文](windows-persistent-panes.zh-TW.md)). Its disconnect/stop/revocation rules replace the exec-only lifecycle below; ordinary runtime-client exit preserves those resident panes.

This preview lets a native Windows computer connect **outbound** to a central AgEnD coordinator. The computer reports its installed coding CLIs and executes Agents assigned to that machine. Its own CLI login, filesystem, ADB and serial devices stay on that computer. Opening the dashboard from another computer does not provide that browser's local tools.

The coordinator still owns the shared Fleet, Agent settings, task board, delegation, chat and permissions. A runtime owns local processes and a bounded execution journal. An Agent is pinned to its selected machine; a disconnected machine never causes its Agent's prompt to be automatically rerun on another machine.

Design references, source-review scope and bundled license notices are recorded in [Remote Runtime provenance](remote-runtime-provenance.md).

## Runtime version reports

Current runtimes report their own package version, code Build ID, supported protocol versions and transport capabilities when connecting. Open a computer card's **Computer information** menu to inspect them. `agend-runtime --version` prints the same installation's information without connecting or reading its private profile; `status` includes it alongside profile status.

The code Build ID hashes the installed fixed runtime modules (including the pane helper scripts) and package version. It distinguishes different program builds carrying the same alpha version; it is not a signature or the downloadable ZIP's SHA-256, and excludes user profiles, CLI installations and runtime dependencies. An incomplete program installation has no Build ID. Unreadable package metadata remains unknown instead of using the coordinator's version.

Older runtimes that report nothing keep connecting over protocol v1 and show **This Runtime does not provide version information**. Replace the portable program folder once (or run the [one-line install](#one-line-install-windows-powershell) again) and reconnect the existing profile to enable reporting. Reported capabilities grant no permissions. Reconnecting with an older client clears the prior connection's version report.

### A Runtime that does not match this AgEnD

AgEnD needs a Runtime that speaks a protocol AgEnD speaks (today: protocol 1) and offers the `exec` capability. A Runtime whose report says otherwise was installed from a different AgEnD release, so AgEnD **refuses it clearly instead of letting it connect and fail later**:

- AgEnD does not welcome it and sends it no work. Its computer card in **Settings → Runtime** stays offline and says it is not compatible and that the install command must be run again. The report is kept so you can see which version it is.
- The Runtime's own window stops with a non-zero exit and says: AgEnD refused it because its version is not compatible, **re-run the install command** shown in Settings → Runtime → Connect a computer, then start it again with `agend-runtime run`. The pairing is kept; no new code is needed.
- Running the install command again installs this AgEnD's Runtime **next to** the old one. It never deletes or replaces a version folder, so a Runtime that is running keeps working, and `agend-runtime` is repointed only after the new version is whole (see below). If you installed from the ZIP, download the ZIP from the same page instead.

A Runtime that reports nothing at all (installed before reports existed) is not refused: it is shown as legacy, with a hint to run the install command again. There is no automatic update or remote installation.

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
   - **Windows (PowerShell)**: copy the **install command** (it checks the SHA-256 of `install.ps1` shown on the page before running it), paste it into PowerShell on the other Windows computer, then copy the **connect command** and run it there. See [One-line install](#one-line-install-windows-powershell).
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

**Settings → Runtime → Connect a computer → Windows (PowerShell)** shows two commands with the address you confirmed in step 1. Run the first on the other Windows computer, in PowerShell, as the Windows user whose CLIs are installed. No administrator rights are needed.

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $agend = 'https://your-agend-host'; $s = $null; $h = $null; $s = (iwr "$agend/runtime/install.ps1" -UseBasicParsing).Content; $h = (-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })); if ($s -and $h -eq '<sha256 shown on the page>') { iex $s } else { Write-Host 'install.ps1 could not be verified against the hash on the AgEnD page (a certificate or download error above is the usual cause: trust this AgEnD certificate, or use the ZIP; otherwise reload the page and copy the command again)' -ForegroundColor Red; throw 'install.ps1 was not run' }
```

The page fills in your address and the SHA-256 of `install.ps1`. The command downloads the script, hashes the bytes it received, compares that with the hash on the page, and runs the script **only if they are equal**. It prints the next command and does **not** connect and does **not** pair:

```powershell
agend-runtime connect --server "https://your-agend-host"
```

The one-time pairing code is typed into that terminal when it asks, never put in either command. Then compare the **Pairing fingerprint** and approve the computer in AgEnD exactly as in [First connection](#first-connection). The ZIP flow is unchanged and remains under **Other install methods (ZIP)**.

### Why the command pins the script

The script and the Runtime archive come from the same server over the same TLS channel, so a hash written inside the script can only prove that the archive matches the script. It cannot protect against a modified script, which is the real risk of running a downloaded script. The page the administrator is looking at is the trust anchor: the script's SHA-256 is shown there and put in the command, and is checked **before anything of the script runs**. So the integrity of what runs does not depend on a TLS trust decision. The script then checks the archive against the hash pinned inside it (a second, separate check).

- The hash on the page is read from AgEnD by the signed-in local administrator, not from the script's own response. The server builds the script once as bytes and sends exactly those bytes every time (no newline rewriting, no compression, nothing that depends on the request), so the hash shown is the hash of what is sent. A script modified in transit, a line-ending conversion, a byte-order mark or a script from another server fails the check. So does a stale page: after AgEnD is updated, reload the page and copy the command again.
- **No failure reaches `iex`.** In PowerShell a failing .NET method call is only statement-terminating: that statement is skipped and the next one runs, so a check written as `if (<hash check>) { throw }; iex $s` would run the unverified script whenever the hash cannot be computed (for example under Constrained Language Mode, where `[Security.Cryptography.SHA256]::Create()` is refused). The command is therefore written the other way round: `$s` and `$h` are cleared first, the hash is computed into `$h` in a statement of its own, the condition is only `$s -and $h -eq '<hash>'` (nothing in it can throw), and `iex` sits only inside the branch that condition admits. Whatever fails (the download, the hash, the TLS line), `$h` stays empty, the condition is false, and the other branch prints why and throws; `iex` is never reached. The first statement only adds TLS 1.2 to this PowerShell session (Windows PowerShell 5.1 may not offer it by default); if it fails, nothing the check depends on has changed, and the check still refuses. (The message is written with `Write-Host` before the `throw` because a person's own `$ErrorActionPreference = 'SilentlyContinue'` swallows a bare `throw`.) This shape differs from `if (-not $s -or <hash> -ne …) { throw }; iex $s`, which fails open, and that is the only reason for the difference.
- If the page cannot get the hash (for example the Runtime files were not built on this AgEnD), it shows no install command at all and points to the ZIP; there is no unpinned fallback.
- **If PowerShell reports a certificate error** (for example a self-signed certificate: Windows PowerShell 5.1 refuses those), make that computer trust the AgEnD server's certificate, or use a trusted HTTPS address such as Tailscale Serve, or use the ZIP. **Never turn certificate validation off**, by any switch, callback or policy: this documentation never suggests it, and the command never does it. The hash check does not replace TLS; it removes the need to trust the connection for the script's integrity.
- The address is taken **only** from `$agend`, which the page filled in with the reviewed remote-runtime address you confirmed in step 1. The script reads the address from nowhere else: not the `Host` header that served it, not a redirect, not the network. An address with credentials, a path, a query, a fragment or a quote produces no command; plain `http` is accepted only for `localhost` (an SSH forward).
- Under **Constrained Language Mode or AppLocker** the command **stops without running anything**: the hash cannot be computed there, so the script is never trusted. Use the ZIP instead. `iex` of a string is not subject to the execution policy, and the command never changes your execution policy (machine, user or process).

### What the install script does

1. Checks that Node.js 22.14 or newer (22.14+, 23.6+ or 24+) is installed. If not, it stops and shows `winget install OpenJS.NodeJS.LTS` or nodejs.org. It never installs software for you.
2. Downloads the Runtime archive from `$agend` (one bounded request, redirects refused, at most 16 MiB).
3. Computes the archive's SHA-256 itself and compares it with the checksum written inside the installer script. On a mismatch it stops before anything is unpacked.
4. Unpacks into `%LOCALAPPDATA%\agend-runtime\<version>+<build>`, **beside** any version already there. `<build>` is the first 8 characters of the archive's SHA-256, because one version number can cover more than one build.
5. Points `agend-runtime` at it (below), and adds `%LOCALAPPDATA%\agend-runtime\bin` to **your user PATH**.
6. Prints the connect command.

**Versions side by side.** An existing folder is never deleted or replaced, because it may be the Runtime that is running right now (a running Windows program holds its files). The install folder is named `<version>+<build>`, so a newer AgEnD's Runtime, and a different build of the same version number, each add a new folder beside the old ones; running the same build's command again finds its own folder and only repoints `agend-runtime`. Nobody has to delete a folder by hand to update. `bin\agend-runtime.cmd` is written once and never changes: it starts the version named in the one-line file `bin\current.txt`, and the install swaps that file in with an atomic replace only **after** the new version is whole. So `agend-runtime` starts either the old or the new version, never a half-installed one, and a batch file that is running is never rewritten. The shim starts with `setlocal DisableDelayedExpansion`, so a `!` in the install folder (an accepted `AGEND_RUNTIME_INSTALL_DIR` can contain one) is kept even when cmd.exe runs with delayed expansion on (`/V:ON` or the DelayedExpansion registry setting). A Runtime that is already running keeps its own version until you stop it (Ctrl+C) and start it again with `agend-runtime run`. If a failure happens before the switch, `current.txt` still names the working version. **Earlier folders are not removed by this installer** (one of them may be running); clearing old ones comes with the update and uninstall commands in a later phase. Until then they stay, and you can delete one yourself once no Runtime uses it. The one case the script refuses is a folder that already carries this build's own name but does not hold it, which only happens if it was changed by hand or left incomplete: it is left alone, and the script says so.

**PATH.** The `bin` folder is added to the **user** PATH by writing the registry value back with the kind it had, so a PATH with `%VARIABLES%` stays expandable. `[Environment]::SetEnvironmentVariable('Path', …, 'User')` is not used for the write because it turns a `REG_EXPAND_SZ` PATH into a plain string (measured on Windows PowerShell 5.1 and PowerShell 7), and `setx` is never used because it truncates at 1024 characters. An entry already there, written out or with `%VARIABLES%`, is not added again, and nothing else in the PATH is touched. A running terminal does not see the change; open a new one, or use the full path the script prints.

It deletes only its own staging folder, a temporary sibling file it just wrote, and an install folder it created itself and that is still empty after a failure. It reports failures with a non-zero `$LASTEXITCODE`.

Optional variables, set in the same PowerShell window before the command:

| Variable | Effect |
|---|---|
| `AGEND_RUNTIME_NO_PATH=1` | Leave PATH alone. The final message then shows the full path of `agend-runtime.cmd` to run. |
| `AGEND_RUNTIME_INSTALL_DIR=D:\agend` | Install under this folder (a full drive path) instead of `%LOCALAPPDATA%\agend-runtime`. |

### What the server serves

Three read-only GET routes, next to the pairing endpoints, need no sign-in:

| Route | Content |
|---|---|
| `/runtime/install.ps1` | The installer script, with this server's runtime version and the archive's SHA-256 written into it. |
| `/runtime/v1/bundle/windows.zip` | The generic Runtime archive: the same `createRuntimeBundle()` output Settings downloads, without `agend-server.json`. |
| `/runtime/v1/bundle/windows.json` | Exactly `{version, sha256, bytes}` for that same cached archive. No download URL or pairing data. |

They are served only while **Allow other Windows PCs to pair** is on (otherwise all answer `404`, exactly like an unknown route), never through a public gateway link (`404` there too: the gateway does not list them), and only over HTTPS or loopback (plain HTTP from anywhere else is refused with `403`). The usual Host allow-list still applies.

Both are **static for a server version**: the generic bundle is built once per server process and kept, so its hash is stable, and the script is that bundle's version and SHA-256 inside a fixed template. Nothing in a response depends on the request: not the Host header, a query (a query is refused), a cookie or the caller. Neither carries a token, secret, pairing code, profile, user data or server address; the address comes from `$agend` in the command. The script is never cached (`Cache-Control: no-store`). The archive carries `Cache-Control: no-cache` and an `ETag` made from the server version and its SHA-256; a matching `If-None-Match` is answered `304` without the body. The script still verifies the archive's pinned SHA-256, so a cached copy is never trusted on its own. Downloading the installer grants no authority: pairing (one-time code, ten-minute expiry, fingerprint, local administrator approval) is unchanged, and an unapproved computer can do nothing.

The metadata comes from that same cached bundle, so its hash and byte count describe the ZIP actually served. ZIP and metadata use the same `ETag` (`"<version>-<sha256>"`), `Cache-Control: no-cache` and conditional `304` behavior. `HEAD` returns their headers without a body. This metadata endpoint prepares the server contract for automatic updates; it does not switch a running Runtime by itself.

Requests are rate limited per client address with a small burst (a few downloads in a row, then a steady rate; ZIP and metadata share one allowance, and the script has its own), and in total, because a reverse proxy makes every client look like one address. Conditional requests and `HEAD` also count. A client address is asked first: a request its own allowance refuses costs the shared total nothing, so one address that hammers a route is held by its own limit and cannot use up what everyone else shares. A held request gets `429` with `Retry-After`. The archive can never exceed the bundle's 8 MiB cap.

### Remove it

Disconnect the profile and delete the program folder, then remove its `bin` folder from your user PATH (Windows **Settings → System → About → Advanced system settings → Environment Variables**, user variable `Path`):

```powershell
agend-runtime disconnect
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agend-runtime"
```

That removes every version folder at once; stop every Runtime window first.

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

## More than one Claude account on one computer

A Windows computer can keep several named Claude Code sign-ins ("credential profiles") and each agent can use one. The names work like the Linux/WSL `credential_profile`, but everything stays on that computer.

On the Windows computer, in the Runtime folder and under the Windows user whose Claude Code you use:

```powershell
.\agend-runtime.cmd login claude-code work       # creates the sign-in and runs `claude auth login` for it, here
.\agend-runtime.cmd login claude-code home
.\agend-runtime.cmd profile list                 # name and signed in / not signed in
.\agend-runtime.cmd profile default work         # optional: used by agents that choose none, for this pairing
.\agend-runtime.cmd connect --credential-profile work   # the same default, set while connecting
```

Then choose **Detect again** in that computer's **CLI diagnostics** (Settings → Runtime): the card lists the profile names and whether each is signed in, and the agent settings (new Windows agent, **Change runtime / CLI**) offer a **Claude account** choice. Changing the account of an existing agent starts a new conversation, like any runtime change, because a conversation lives in one account's folder.

How it is kept safe:

- **AgEnD only sends a name.** The Runtime turns it into `<this pairing's profile folder>\credential-profiles\claude-code\<name>` on that computer and sets `CLAUDE_CONFIG_DIR` for that one run or terminal, replacing any ambient value. A name resolves only through that fixed folder; anything that would leave it is refused. AgEnD never accepts, stores or sends a folder.
- **Changing the default** (`profile default NAME` or `--clear`) works while the Runtime is running and is used from the next run or new terminal; a terminal that is already open keeps the profile it started with, and reconnecting does not disturb it.
- **Consent.** The profiles live in the pairing's own folder, and only the computer's local administrator creates and signs one in. Approving the pairing lets that fleet use every profile signed in there, and no other fleet that pairs with the same computer. The fleet admin can choose which profile an agent uses from the ones the computer reports; they cannot create a profile, set the pairing's default, read a credential or point at a path. The pairing's default profile is set only on the computer (`connect --credential-profile` or `profile default`).
- **Names** follow the Linux rule (letters, digits, `.`, `-`, `_`; start with a letter or digit; at most 64) and also exclude Windows device names (`con`, `nul`, `com1`…, also with an extension such as `nul.txt`) and trailing dots, which Windows would alias to another folder. Names are unique without regard to letter case when creating, listing and resolving: `work` is refused when `Work` exists, and two folders that differ only by case are neither listed nor usable.
- **Sign-ins never leave the computer.** Only the names and a signed-in yes/no are reported to AgEnD; no path, e-mail or token.
- **It fails closed.** An unknown, signed-out or unconfirmed profile, a malformed name, or a Runtime that is too old to report the `credential-profiles` capability stops the run or terminal with a message that says what to do. It is never replaced by the computer's own account. AgEnD refuses to send a profile to an older Runtime for the same reason.
- **Which account is it?** The Runtime reads `claude auth status` on that computer for each profile and for its own default sign-in and reports only a masked e-mail and the plan, shown as `work · ab***@example.com · Team` on the computer's card and in the **Claude account** choice. The mask keeps one or two characters of the local part, then `***`, then the whole domain (so a work and a personal account can be told apart); the full address never leaves the computer, is never logged and is never written to the Runtime's disk. A missing or non-ASCII address sends none; an API-key sign-in is shown as "No account email (API key)". The plan is one of `free`, `pro`, `max`, `team`, `enterprise`, or `unknown`. AgEnD accepts only that exact form and treats anything else as a protocol error that names the field, never the value. It is refreshed only when you choose **Detect again**, and automatically after `agend-runtime login` (so signing a profile in to another account updates it). A Runtime without the `account-identity` capability simply shows no account. Only fleet admins see it, on the Runtime page, the account choice and Settings → Agents.
- **Terminals** (persistent panes) take the profile per terminal, so one long-lived host never carries another account's environment. A terminal host that is already running from before an upgrade keeps refusing profiles until its panes are closed and a new host starts.
- **Limits.** Claude Code only. A sign-in made with a Console login that creates no API key is stored outside the config folder and cannot be separated by profile. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are still not passed to a Windows Runtime's Claude Code. AgEnD shows no usage or quota for accounts on a Windows computer. Changing a pairing's default account makes conversations that were started under the old account impossible to resume under the new one.

## Letting AgEnD manage accounts on a computer (remote setup)

By default a fleet administrator can only *choose* among the profiles a computer already has. With the **accounts** switch on, the computer's local administrator also lets the dashboard add, sign in, sign out and remove Claude Code profiles **that this Runtime created**. A second switch, **install**, is reserved for installing a CLI from the Runtime's own closed list. This section is the Runtime side (#3190 Part 3a); the dashboard screens come later.

```powershell
.\agend-runtime.cmd remote-setup status
.\agend-runtime.cmd remote-setup accounts on --for 2h    # off again by itself after two hours
.\agend-runtime.cmd remote-setup accounts off
.\agend-runtime.cmd remote-setup install on|off          # same shape; a Runtime reports `cli-install` only when it can install
```

- **Off by default, set only on that computer.** The switches live in `remote-setup.json` in the pairing's own folder. Nothing in the Runtime protocol writes them, so AgEnD cannot turn one on. While a switch is off every matching request is refused with the command to run there. The two switches are independent. `--for` takes `2h`, `90m` or a number of hours (1 minute to 168 hours); an expired switch is off, and so is a timed switch whose end is further away than 168 hours from now (a clock that was moved back, or a hand-written value, cannot bring it back). While a sign-in is open the Runtime looks at its switch every few seconds: if the switch is turned off or runs out, the sign-in is ended (its CLI process is killed, and again at the next look if that could not be confirmed) and the record says `switch_off`.
- **Two requests do not look at a switch, on purpose.** `accounts.switches` only reads the two switches, so a dashboard can say why a request would be refused. `signin.close` only ends a sign-in that is already running, so turning a switch off can never leave a sign-in that cannot be closed.
- **Own frames, not stored by AgEnD.** The requests travel as `account.request` / `account.response`, not as `request`: the server journals every `request` and its answer to disk, and a sign-in link or one-time code must not be written there. Capabilities: `remote-signin` (this Runtime can do the account operations) and `cli-install` (only when an installer is wired in; this program reports it never yet). AgEnD must send an `account.request` only to a Runtime that reports `remote-signin`; an older Runtime treats the frame as a protocol error and disconnects.
- **Names and ids only.** A request carries a CLI id, a profile name, a sign-in method and the person's name for the record. Never an argv, a command, a path or an environment; an extra field is refused naming the field, not its value.
- **Sign-in.** The server's `StructuredSignIn` drives five calls (start, capture, status, write, close). The Runtime builds the command itself (`claude auth login --claudeai`), with `CLAUDE_CONFIG_DIR` set to the profile's folder, `BROWSER=true`, pipes, no shell, and a scratch folder it removes at the end.
  - **Subscription accounts only.** A request for a Console sign-in (`method: "console"`) is answered `unsupported` with the command to run on that computer (`agend-runtime login claude-code NAME`): a Console login that creates no API key is stored outside the config folder, so a profile could neither isolate nor remove it. The protocol keeps both method values so that this can be opened later without changing it.
  - **Minimum Claude Code 2.1.79.** The host's sign-in picks the method in the menu of `claude auth login`; the Runtime has pipes and no menu, so it passes the flag. Measured: `claude auth login --help` of 2.1.78 lists no `--claudeai`, that of 2.1.79 does (and `--console`, which the changelog records for 2.1.79); 2.1.319 was used for everything else here. A Claude Code that does not know the flag exits at once, and `signin.status` reports `alive: false` immediately; it does not wait for the ten-minute limit.
  - **What `capture()` carries.** It is not the CLI's output: it is rebuilt from a closed table of lines: the sign-in link, the code prompt, and the outcome, each in its fixed form (`Logged in as <e-mail>` reaches the server as `Login successful`). The link must be `https://` followed by printable ASCII only (a bell, backspace, NUL or any control character drops the line), on an allowed host, no credentials, at most 4096 characters, and is sent as the URL parser writes it back. **The link's query string is chosen by the CLI and is not a closed set**; it is the sign-in request itself, so it is what lets the administrator's browser sign in, and it is shown to administrators only. Outcome lines count only at the start of a line (or right after the prompt, where the CLI prints its verdict).
  - **Limits.** One code per sign-in, in the characters a code has, only while the prompt is showing, sent with a carriage return (measured on Linux with claude 2.1.319 and a temporary `CLAUDE_CONFIG_DIR`: a wrong code gets `Invalid code` with `\n`, `\r` and `\r\n` alike; the Windows check is still to do). One sign-in at a time on the computer, at least 5 seconds between starts and at most 12 an hour, and a ten-minute timeout (retried until the process is confirmed gone), all enforced here. A sign-in whose process has ended, or whose earlier close failed, is closed again by the next start, so it cannot block sign-ins until the Runtime restarts.
  - **Success** is the CLI's own `auth status` for that profile (the shared parser), never output text. A test pins that this flow's argv and patterns equal the host's `LOGIN_FLOWS["claude-code"]`.
- **Only what this Runtime created.** Sign-out and remove need *evidence* that the Runtime made the profile (`created.json` in the profile root, written when `login` or a remote sign-in creates it) and that it sits where it should: under this pairing's fixed root, a valid name, a real folder, and no link at any level. The four levels above and including the profile folder (the pairing folder, the profile root, the CLI folder, the profile folder) are checked as links **and** as any other Windows reparse point (junction, symbolic link, OneDrive placeholder and so on) by asking Windows PowerShell; if that cannot be answered (PowerShell missing, or restricted by a constrained language mode) nothing is changed. Inside the profile folder only links are looked for (what the file system reports as a symbolic link or junction); other reparse points inside are not checked. A folder made by hand, or by a Runtime from before this feature, is only changed on the computer. The Windows user's own sign-in (`~\.claude`) is never touched.
  - **Remove** renames the folder to a unique temporary name first (renaming a link renames the link itself), then checks again: the folder above it (its real path must be this pairing's `credential-profiles\claude-code`), the renamed folder itself (a real folder, not a reparse point, nothing linked inside), and only then deletes it; any failure puts the name back. So a folder, or the CLI folder above it, swapped for a junction between the check and the delete is neither followed nor deleted.
  - **A leftover is never silent.** If a removal fails and the name cannot be put back either, the folder stays as `.removing-<16 hex>` (not a valid profile name, so it is never listed as a profile or selected) and may still hold a sign-in. `agend-runtime profile list` on that computer lists it and says what to do: delete the folder yourself to finish removing it, or rename it back to its profile name to keep it. The Runtime never deletes or restores it by itself.
  - **One start at a time on the computer.** Starting a sign-in takes a computer-wide flag in the same synchronous step as the switch and profile checks, and keeps it until the sign-in is running (or has been refused), because the sign-in slot itself is only taken at the end: without it, many starts under different names could each pass the checks, record `started` and create a folder before the first one took the slot. The same holds for installs (one at a time). The other changes are exclusive per profile, which is enough because each of them names a profile.
  - **One operation at a time per profile.** Sign-in, sign-out and remove of the same profile (by lower-case name) cannot overlap: the second is answered `busy`.
- **Sign-out** runs `claude auth logout` for the profile and deletes `backups\.claude.json.backup*` in it, then confirms with `auth status`. **Sign-out and remove are refused** (not queued) while a task or terminal runs under the profile, while a sign-in for it runs, and while another operation on it is in flight. A terminal counts when it is not exited in the pane host's ledger (`pane-host\state\panes.json`, or `panes\panes.json` for an in-process host); a Claude Code terminal that names no profile counts as using the pairing's default. A row recorded under an earlier boot of the computer cannot still be running and does not count (the pane store treats it the same way after a restart). If the ledger, or the default profile a terminal needs, cannot be read, the answer is `unconfirmed`: the request is refused with a message that says this computer could not confirm the state of its terminals and sends the person to that computer, not a message that claims a terminal is running.
  - **At least 5 seconds between two sign-outs or removes of one profile** (by lower-case name; a request refused for another reason does not start the wait): the answer is `rate_limited`. This only slows a server that keeps asking. **The risk that remains, stated plainly:** while the accounts switch is on, a compromised AgEnD server can still sign a Runtime-created profile out again and again (and, once, remove it). The computer's local administrator accepts that when turning the switch on and choosing how long it stays on (`--for`); the rate limit and the switch's time window bound it, they do not remove it. **Remove** is also refused for the pairing's default profile (only the Runtime knows it). **Sign-out of the default profile is allowed**, which is the difference between the two.
- **Record.** Operations that change something are appended to `audit.jsonl` in the pairing's folder, before and after: a switch change (`local`), a sign-in start and its end (signed in, failed, timeout, switch off), the creation of a profile, the submission of a sign-in code (`signin.write`; who, when, which profile; never the code), sign-out, remove and install. `accounts.check` and the screen reads only read, and are not recorded; `accounts.switches` and `signin.close` are described above. The line is built from a closed set of fields, so a link, a code, CLI output, a folder listing or an e-mail cannot be written. If the record of a remote operation cannot be written, the operation does not run; turning a switch **off** works regardless (the record is then best effort and the person is told).
  - **Refusals are folded.** A refusal that repeats within a minute is not written again; it is counted, and the count is on the next line of its kind (`repeated`), or is written when the next real operation starts. **The folded line carries the actor, profile and CLI of the first request of that run only; the requests counted in `repeated` may have named other actors, profiles and CLIs. `since` (a UTC ISO time) is where the folded run began; `at` is when the line was written.** A count that has not been written when the Runtime is killed (not stopped) is lost; that is accepted, because the first refusal of every window was already written. The key is the action and the reason only, never the actor, profile or CLI, which the server chooses. This only holds because every refusal that changes nothing is made *before* `started` is written: a request is first checked (switch, one operation per profile, then the operation's own checks: its form, ownership, in use, a free sign-in slot, the CLI being there, a wrong or repeated code, a closed table) and only a request that will really do something leaves a `started` line. `signin.write` follows the same rule, so a flood of wrong codes folds into a line or two. Five rotated copies of about 1 MiB are kept. Started, ok and failed entries and switch changes are never folded, so the most refusals can add is one line per (action, reason) per minute, and a flood of requests cannot push real operations out.
  - **`actor` is what the server says.** The Runtime cannot check it: a compromised server can put any value there. The record shows what a server asked for and what the computer did; it is not proof of who sat at the dashboard.
- **Codex.** Not offered on a computer yet. Codex can keep its login in the Windows Credential Manager (`cli_auth_credentials_store`) instead of a file in its home folder, which a profile folder can neither hold nor remove, so signing out or removing a Codex profile would leave the login behind. Every operation refuses Codex with that reason until a Windows check shows where it keeps its login and a profile can be confined to a file.

## Installing a CLI on a computer from the dashboard (remote setup, 3b)

With the **install** switch on (`agend-runtime remote-setup install on --for 2h`), a fleet administrator can press **Install** on a paired computer's card in Settings → Runtime. It is off by default and only that computer's local administrator can turn it on; the dashboard can read the switch but never change it. A Runtime reports `cli-install` only when it has an installer (native Windows on x64; Windows on ARM is not supported by this version); an older one is told to update.

- **Claude Code and Codex only.** The server sends a CLI id. The package, the **exact version**, the registry (`https://registry.npmjs.org/`), the argv and the folder are written in the Runtime (`runtime-cli-install.ts`). The version and the registry hashes of its packages are one entry of one table, so they only change together; the version is a fixed pin for integrity and is not tied to the persistent-terminal version list. Grok, Antigravity and Kiro are not installed from the dashboard: they ship as vendor PowerShell scripts (or an MSI that needs an administrator) whose content cannot be pinned, so the dashboard shows each official command for the computer's owner to run.
- **Per user, no administrator, no PATH change.** `node.exe npm-cli.js install <package>@<version> --ignore-scripts` with no shell, into `<pairing folder>\cli\<id>\<version>`. No global npm, no vendor script. The child environment is an allowlist (Windows basics, proxy and certificate settings); no fleet secret reaches it.
- **Four checks, all required before `current.json` moves** (atomically): npm's own integrity check; the registry sha512 of every package, written in the Runtime; `npm audit signatures`; and the Authenticode signature of the native binary, whose certificate subject must have a CN and an O that are each exactly the expected name (`Anthropic, PBC` / `OpenAI OpCo, LLC`; a name that merely starts with it, or a right O beside a wrong CN, is refused). Any failure leaves nothing switched. A version that is already installed is left untouched (installing it again does nothing). Replacing an install moves the old folder aside as `<version>.old`, puts the new one in place, then deletes `.old` (a failed delete is ignored and cleared at the next install); if the swap fails, the old folder is moved back and `current.json` is not touched. After a switch, the other versions of that CLI and the npm cache are removed on a best-effort basis. A link where the Runtime is about to write is refused. There is no uninstall yet.
- **The Runtime finds it first.** `findCli` looks in `<pairing folder>\cli` before the PATH (the folder is passed to the helpers through `AGEND_MANAGED_CLI_ROOT`, an allowlisted Windows-path variable). A pointer for another version than this Runtime pins is not used.
- **One at a time, one overall 10-minute deadline for all steps together (npm install, signature audit and publisher check), stopped with the Runtime.** The deadline ends the install as `timed-out`; the Runtime stopping ends it as `cancelled`; npm output beyond its size limit is `install-failed`. AgEnD's own wait is 11 minutes, longer than the Runtime's. A second install is refused (also when two requests arrive at the same moment, and while the first request is still waiting for the Runtime's first answer); failures are typed (`npm-missing`, `install-failed`, `timed-out`, `integrity-mismatch`, `signature-check-failed`, `publisher-mismatch`, `cancelled`) with sentences that carry no path, URL or npm output. The dashboard shows the job as installing, done or failed; it does not show the individual steps.
- **A refusal that comes back at once is an error, not a job.** After sending the request, AgEnD waits up to 1.5 seconds for the computer's answer. If the computer refuses in that time (its install switch is off, the CLI is not in its table, it is offline), the request answers 400 with the computer's own sentence and leaves no job (an earlier job is shown again). If nothing has come back by then, the request answers 202 and the page follows the job.
- **Not stored by AgEnD.** The request travels as `account.request` through `RuntimeCoordinator.callAccount`, kept in memory only: no journal write, no file, no log of the payload or the answer. The install job the page follows is also memory only.
- **Who may ask.** A local administrator session only (the same people as for seeing an account): not a header token, guest, public link, outside administrator or an agent. The name in the computer's `audit.jsonl` is an opaque session handle (`admin:<16 hex>`).
- **Not done here:** uninstall (delete `<pairing folder>\cli\<id>` by hand), update (a new AgEnD release moves the pin), Codex sign-in.

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
