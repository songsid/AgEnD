# Paired Windows runtimes

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
3. Click **Download Windows Runtime (ZIP)** inside the connection section. This authenticated download includes the reviewed public origin in `agend-server.json` and a `connect-agend.bat` launcher. No pairing code, browser token or machine credential is embedded. The address is read as JSON, never interpolated into a batch command.
4. Transfer the ZIP to the Windows computer, extract it, and double-click **connect-agend.bat** under the Windows user whose CLIs are installed and signed in. A supported Windows Node.js installation is still required. The Runtime prints the destination before asking for a pairing code.
5. On first connection, enter the one-time code from Settings. Compare the **Pairing fingerprint** printed in the Runtime terminal with the fingerprint on the machine card, then approve it in AgEnD. Keep the terminal running. If AgEnD ends the connection (the computer was revoked or is not recognised, another Runtime took over the same pairing, or AgEnD rejected a message), the window stays open with the reason and the next step, and the exit code is non-zero; stopping with Ctrl+C is the only silent exit. If it says the profile still holds an unfinished job from another pairing, check that no CLI that job started is still running, delete `jobs.json` in the profile folder as the message says, and pair again. An existing profile paired with the same origin reconnects without asking for another code; a profile paired with another origin is never reused or sent to the new server. With a connection-ready ZIP, `connect-agend.bat` keeps that profile untouched and pairs a separate one under `%USERPROFILE%\.agend-runtime\profiles\<host>-<port>`; the same bat, and `run`, `status`, `rotate` and `disconnect` started from that folder, find it again. Without `agend-server.json`, or when you choose one yourself with `--profile DIRECTORY` or `AGEND_RUNTIME_HOME` (which always wins), the command fails and names both addresses; keep both with a separate `--profile` and pass the same `--profile` to every later `run`, `status`, `rotate` and `disconnect`.
6. In Settings, explicitly detect this computer's CLI inventory when needed. Connecting alone starts no CLI discovery.

The manual command remains available under **Manual connection command**:

```powershell
.\agend-runtime.cmd connect --server https://your-agend-host --name "Windows desktop"
```

`run` still reconnects a saved profile. Connection defaults never replace its credential or retarget it to another server. Generic packages without `agend-server.json` keep supporting the explicit `--server` command. The connection-ready download uses an administrator POST with the existing same-origin and CSRF protections; GET download URLs cannot embed a caller-selected server.

The download requires an administrator session on the local dashboard and is unavailable through public gateway links. It includes program assets, license notices and, for a connection-ready download, the administrator-selected public server origin. It excludes pairing codes, machine credentials, CLI sign-ins and workspaces. If installed runtime assets are missing, update or reinstall AgEnD and retry. Developers can also run `npm run build:runtime` after the normal TypeScript build and transfer the resulting `.artifacts/runtime-bundle` folder.

## Network connection

The runtime uses `/runtime/v1/connect` on the same externally reachable AgEnD service as pairing and the dashboard. Remote origins require HTTPS/WSS and a valid certificate. HTTP is accepted only for exact loopback hostnames, for example `http://localhost:19280` through a private SSH forward. The client refuses credential-bearing URLs and redirects.

The existing coordinator listener still binds to loopback. Publishing a new port, changing a firewall or configuring TLS/proxy access is a separate host operation; pairing does not make the listener reachable automatically. A proxy must pass WebSocket upgrades on `/runtime/v1/connect` and POST requests on `/runtime/v1/pair`, `/runtime/v1/claim` and `/runtime/v1/rotate`. Pairing codes expire after ten minutes and are single-use. The runtime machine credential is unrelated to browser sessions; browser cookies and origins cannot authenticate the runtime channel.

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
