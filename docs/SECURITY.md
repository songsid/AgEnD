# Security Considerations

Running coding agents remotely through Telegram or Discord gives chat participants a way to request actions on the host. AgEnD's chat permissions, MCP tool permissions and HTTP credentials protect different entry points; they do not sandbox the coding CLI.

Paths below use the default data directory, `~/.agend`; `AGEND_HOME` can select another directory.

## Chat access and administration

An admitted user can ask an agent to read files, change code or run commands, subject to the backend's permissions. Treat those users, their accounts and any admitted bots as trusted with the agent's workspace and host access.

- Use an explicit `access.mode: locked` and a small `allowed_users` list to restrict fleet chat access. **Omitting the entire `access` block falls back to open.**
- Persisted access mode overrides YAML; persisted and YAML user lists are unioned. Removing a user from YAML alone may not revoke access. See [configuration](configuration.md#channelaccess).
- Fleet administration requires an explicit entry in the target instance’s owning adapter's YAML `allowed_users` (the invoking adapter when there is no target). Open access or pairing approval alone does not grant that role. ClassicBot has its own admin and chat allowlists; see [permissions](permissions.md).
- Enable account 2FA and protect bot tokens. `tool_set` is enforced on AgEnD operations at the server; it does not restrict the backend's own shell, filesystem or network tools.

## Permission bypass (`skipPermissions`)

For Claude Code, **bypass is enabled by default**: AgEnD passes `--dangerously-skip-permissions` unless `skipPermissions` is explicitly `false`. The flag bypasses Claude's tool permission prompts, so an admitted chat request can lead to host actions without an individual approval.

Set `skipPermissions: false` to omit that flag and use Claude Code's own permission configuration. AgEnD does **not** generate a shell allowlist or a destructive-command denylist. Configure restrictions in the CLI's supported user/project settings, and use OS isolation when you need a host boundary.

The per-instance `claude-settings.json` is generated again on startup (including the status line and bypass-warning acceptance when applicable). Do not use edits to that generated file as a persistent security policy.

## Tool profiles and the shared host account

`tool_set` is policy protection for the instance identity resolved by AgEnD. It
refuses disallowed operations on that identity across MCP, direct IPC and the
agent HTTP endpoint. It is **not a security boundary against a shell-capable
agent running under the same uid**. Such an agent can read a sibling's
`agent.token` or connect to its `channel.sock`, claim the sibling's identity and
receive that sibling's permissions, including a coordinator's. A `0600` file
does not distinguish processes belonging to its owner. Per-spawn rotation does
not change that fact. Treat same-account agents as mutually trusted; use separate OS users or
properly isolated containers for agents that must not share authority.

## IPC socket

The daemon communicates with the AgEnD MCP bridge over `~/.agend/instances/<name>/channel.sock`. AgEnD uses a restrictive umask and attempts to set the socket to `0600`. It creates private instance directories with `0700` and tightens eligible existing directories. There is **no shared-secret handshake**. These filesystem permissions separate Unix users; they do not authenticate or isolate processes running as the same UID, or protect against root. Check warnings when permissions could not be restricted.

## Dashboard sign-in and browser sessions

Two credentials open the local gated dashboard routes, and neither ever travels in a URL:

- **`X-Agend-Token`**, the fleet-wide bearer token in `~/.agend/web.token` (created with mode `0600`; permission tightening on an existing file is best effort). The CLI and scripts send it as a header. It persists across fleet restarts. `agend web-token rotate` replaces it, which also signs every browser out (see below). Rotation is not a promise to retract an already authorized request or close every existing connection.
- **A browser session**, made by signing in with a **one-time code**. A fleet admin gets the code with `/web`: the General menu sends it only by DM, with an awaited Discord ephemeral fallback; Telegram DM refusal asks the admin to `/start` the bot privately. On the host, `agend web` prints one, using the header token. A code is 8 characters, works **once**, expires after **5 minutes**, and only the newest code works. Five wrong tries spend a code. Twenty wrong tries within 15 minutes, across codes, pause all redemption for 5 minutes. While no code is outstanding there is nothing to guess. Local sign-ins are announced in General (`web.notify_login`, on by default); public sign-ins require a confirmed notice regardless of that setting.

A `?token=` in a URL is **not** a credential, including in old links and bookmarks. It gets the sign-in page, and the token is removed from the address bar.

About the session:

- The cookie is an opaque random 256-bit id, unrelated to `web.token` or to the code. The server's session records keep only its SHA-256, persisted in `~/.agend/web-sessions.json`, so a stored record or that file cannot be replayed as a cookie. The raw id still passes through the process: when the session is created (the `Set-Cookie`), and in every request that carries the cookie. At most 8 sessions are kept; past that the least recently used one is dropped.
- The **server** enforces the expiry: by default 48 hours after sign-in, or 48 hours without use, whichever comes first (for the dashboard reached directly, `web.session.local.*` can set them between 1 and 720 hours; a public-link session's limits are fixed; a shorter setting also ends existing sessions it now outlives). Use is what the person does: opening a page, reading a chat's history, any change. The reads a page makes on its own timer are authorized in full but are not use: the dashboard's live stream (`GET /ui/events`, also when it reconnects) and its fallback poll (`GET /ui/poll`), and, with `web.view_access: session`, `/view`'s terminal (`GET /api/pane/<instance>`), roster (`GET /api/profiles`) and usage panel (`GET /api/ai-usage`). The server fixes that list by method and path; a request cannot declare itself passive. So a tab left open does not keep its session alive (#1373). The cookie's `Max-Age` only tells the browser to forget it at the same time. Sessions survive a fleet restart.
- The cookie is `HttpOnly`, `SameSite=Strict` and `Path=/`. On the local listener, when `X-Forwarded-Proto` reports HTTPS it is named `__Host-agend_session` and is `Secure`; use TLS for remote access. Managed public cookies are always Secure, based on the listener-owned context, not a forwarded header.
- **A write authorized by the cookie** must also carry an `Origin` equal to `Host`, a `Sec-Fetch-Site` of `same-origin` when the browser sends one, and the session's own `X-Agend-CSRF` value. The cookie alone cannot change anything. A local header-token request is exempt from cookie CSRF and Fetch-Site checks and may omit Origin. If it supplies Origin, that Origin must still match Host; a page cannot make a browser add the token header.
- On every gated route, an `Origin` whose host/port differs from `Host` (or that does not parse, such as `null`) is rejected. A read without `Origin` is accepted when its credential is valid.
- **Revoking:** the Session menu signs out one device or every device, `/web revoke` signs out every browser and withdraws any unused code, and `agend web-token rotate` ends every session made under the old token on its next request, without a restart.
- **Returning devices (#1570).** A sign-in with a code that `/web` delivered privately also sets a second cookie, `agend_device` (`__Host-agend_device` on https and on the public link; `HttpOnly`, `SameSite=Strict`, 90 days). Its value is a random 128-bit id plus an HMAC keyed from `web.token`; it names no chat or user. `~/.agend/web-devices.json` (`0600`) keeps the id's SHA-256, the owner who received that code, and the token epoch. Only such a browser can ask the sign-in page for a fresh code (`POST /auth/request-code`, which requires `Origin`). The fleet then re-checks that the owner is still a fleet admin of that bot and General, and sends the code by DM only (never a group, no fallback). The DM names the browser and the surface. Limits: per device 1 a minute and 5 an hour, for the fleet 1 every 20 s and 20 an hour (monotonic clock), and none while the wrong-code breaker is open. A public-link request must belong to the open, current exposure; its code is scoped to that exposure and still requires the confirmed public notice. `/web revoke` clears the registry, and `agend web-token rotate` invalidates every device cookie (both the HMAC key and the epoch change).

This is a shared operator credential, not a per-user account or role system. `/web` requires a fleet admin, but whoever holds a code, a session or the header token can use it, and local chat allowlists are not rechecked for each HTTP action. Public requests additionally require the issuing owner/binding and exposure to remain current. Treat a code like a password until it is used; menu codes are sent privately.

## Temporary public gateway and local reads

An explicit owner-adapter General admin action may open the managed public link for two hours (configurable 1–480 minutes, fixed from consent; with a fixed named-tunnel hostname up to 10080 minutes or no expiry, and an opt-in `auto_open` that reopens it after a restart for the last admin who opened it — without sending any sign-in code). Only pinned/checksum-verified cloudflared is used, in the same one-tunnel lane as `/login`. The listener is separate and carries code-owned provenance, not a trusted proxy header. Only the current exact public HTTPS Host and reviewed panel routes are accepted; no wildcard is added to the local Host list. `/view` and usage reads require public sign-in even if local reads are open. Health, agent, issue-code, SSE, preview and legacy restart endpoints are not exposed.

What each way in allows (the dashboard reached directly, the temporary public link, a fixed named-tunnel address), row by row: [The three ways in, compared](web-dashboard.md#the-three-ways-in-compared).

Public cookies are Secure `__Host-` cookies and bind one exposure. The gateway rejects local header tokens, cookies and codes; public codes and sessions are exposure scoped. Public sessions have a four-hour absolute and 30-minute idle limit, also bounded by earlier link closure. Every public login needs a confirmed 🔐 public notice in the owning General within five seconds, regardless of `notify_login`; the candidate is neither usable nor persisted before confirmation. Code leakage can still grant full web-admin access. Cloudflare terminates TLS; forwarding a link alone does not sign in, but reveals the endpoint to guessing and shared-breaker denial of service. Exact Origin plus CSRF protects browser writes; Host checks are not authentication. Expiry, disable, private close, revoke, owner/binding loss and shutdown close access and withdraw public credentials before child cleanup. An unconfirmed child stop blocks another tunnel.

**Web authority over the admin's named link (#2453), opt-in, off by default.** `web.verified_authority.named_link: true` lets a session on the admin's own named-tunnel hostname be authorized with the account's Confirm card (#1939 §0.2).
- **Which requests count.** The gateway marks a request as named only when its pinned host is exactly the configured hostname. No header can set or change that. A quick-tunnel request is governed by the quick-link option below.
- **Turning it on** is a confirmed Settings change: a General's card or the host CLI. It is never self-confirmed by a web-verified session (#2170), and it can't be changed over the public link.
- **Turning it off** applies at once. Every receipt from a named-link session then reads as none (`downgraded: named_link_off`). Turning it back on moves the revocation epoch, so those receipts never come back.
- **`loopback_only`** still wins.
- **Risk accepted by turning it on.** Cloudflare terminates TLS and sees the traffic, including the session cookie. A stolen cookie of an authorized named-link session can be replayed from anywhere until one of these ends it:
  - the 30-minute idle or 4-hour absolute public-session limit;
  - `max_session_hours`;
  - **Not me** on the notice card;
  - `/web revoke`;
  - the option turned off.
- **A named-link session is never the authority that confirms a held Settings change itself.**

**Web authority over the temporary public link (#1939 §0.3), opt-in, off by default.** `web.verified_authority.quick_link: true` lets a session on the temporary public link that `/web` opens (a quick tunnel, `*.trycloudflare.com`) be authorized with the account's Confirm card too.
- **Which requests count.** Every gateway request that is not named, known from the listener alone; no header can set or change it. The session must belong to the current exposure, and every quick URL is a new one.
- **Turning it on** is a confirmed Settings change: a General's card or the host CLI. It is never self-confirmed by a web-verified session (#2170), and it can't be changed over the public link. It is judged on the value in force (the key unset means the default, off). Every time it is turned on, the first time too, the revocation epoch moves in the same write: every authorization given so far ends, and browsers confirm again.
- **Turning it off** applies at once. Every receipt from a quick-link session then reads as none (`downgraded: quick_link_off`), and those sessions' authorizations are dropped. Turning it back on moves the revocation epoch, so those receipts never come back.
- **`loopback_only`** still wins.
- **Risk accepted by turning it on.** The quick URL is a public internet address: anyone who has it reaches the sign-in page. The barrier is the same as the named link's: a sign-in code sent privately to an allowed account, then that account's Confirm for the session. Cloudflare's quick-tunnel service terminates TLS and sees the traffic, including the session cookie; AgEnD starts the quick tunnel with no front authentication. A stolen cookie of an authorized quick-link session can be replayed from anywhere until one of these ends it:
  - the 30-minute idle or 4-hour absolute public-session limit;
  - `max_session_hours`;
  - **Not me** on the notice card;
  - `/web revoke`;
  - Close, or the link's expiry;
  - the option turned off.
- **A quick-link session is never the authority that confirms a held Settings change itself.**

**Signing in does not protect all local HTTP reads.** `/view` and its GET APIs, including `/api/pane/<instance>`, profiles, avatars and sort order, are public to anyone who can reach the listener with an allowed `Host`. The listener binds `127.0.0.1`, but that still includes:
- other local users and processes;
- whatever a reverse proxy, tailnet share or port forward admits (`web.allowed_hosts`);
- on WSL2, the Windows host.

The anonymous `/view` reader sees every instance: it has no account and no scope. Signing in doesn't add one to `/view`: with `web.view_access: open` a signed-in guest can use those same public reads too. Only a guest's own routes are checked against its scope. `/api/ai-usage` is also public when enabled, and GET `/health` needs no token. Pane captures can contain commands, credentials and other private output.

Set `web.view_access: session` to close those reads: `/view`, its GET APIs and `/api/ai-usage` then need a session or the header token, like the dashboard. `/view`'s writes (profile, avatar, sort order) always go through the dashboard gate: a session with the cookie-write checks above, or `X-Agend-Token`, never a `?token=`.

The local health/dashboard listener binds to `127.0.0.1`. Every request, including public reads and `/agent`, must pass the `Host` allowlist: `localhost`, `127.0.0.1`, `[::1]`, configured `hostname`, and names in `web.allowed_hosts`. Missing, malformed or unlisted hosts get 403. The login terminal listener also uses a Host allowlist.

This check limits DNS rebinding from a browser. It is **not authentication**: an ordinary HTTP client can choose an allowed `Host`. If a proxy or port forward exposes the listener, protect public reads at that boundary and add only host names you intend to serve. A `/login` terminal has a separate per-login credential; its temporary public tunnel is not a tunnel to the dashboard. Existing local sessions cannot authorize the managed public host, and public sessions cannot authorize the local listener or a later exposure. See [login configuration](configuration.md#finishing-a-login-away-from-the-machine-public-link).

## Agent HTTP token

`POST /agent` bypasses the dashboard gate and requires `X-Agend-Instance-Token`. The header value is `<encodedInstance>:<token>`, where `<encodedInstance>` is `encodeURIComponent(instanceName)` and `<token>` is the 64-character hex token the daemon writes to `<instanceDir>/agent.token` (mode `0600`) on each CLI spawn. The endpoint decodes the instance name, verifies the token before reading the request body (missing or wrong token returns 401 without consuming the body), and caps the body at 512 KiB (413 if exceeded). The server also enforces that instance's AgEnD tool permissions. A web token is not a substitute for this token. As with the IPC socket, a process running as the same Unix user can read the credential; this is not isolation between mutually untrusted local agents.

## Secrets storage

Bot tokens and API keys are stored in plaintext at `~/.agend/.env`; `web.token` and per-instance `agent.token` are plaintext credentials too. Filesystem permissions restrict access but do not encrypt these files. `web-sessions.json` holds only hashes of session ids, not anything that signs a browser in.

Minimal `agend export` includes `.env` when present; a full export can also include other credential files. The gzip tar archive is not encrypted, and the command warns about secure transfer. Protect exports and backups as credentials. Consider filesystem encryption if the host is shared.

### Sensitive Settings need a second confirmation

A browser session (local or public) can propose changes to access/F/C lists, credentials, connection destinations/order, public exposure and control-bearing instance settings. It cannot commit those changes by itself. The server keeps an immutable, memory-only request for at most five minutes, tied to the live session and configuration snapshot. General shows the complete bounded diff and Confirm / Reject buttons; only a fleet admin on its owning adapter can confirm. Secret values are replaced by key names and fingerprints. Ordinary model/display changes remain immediate, with a snapshot check before writing.

**One exception (#2170): a web-verified account confirms by its own Apply.** A local session that is web-verified (#1939: its account confirmed this browser in a Discord or Telegram DM) is the second confirmation itself when its account is on the change's platform and a fleet admin of every effect owner (the chat card's rule), the scope is known, and an unaffected, connected General exists on that platform. The server claims the request before the chat prompt would be posted, so no card appears; at execution it asks again whether the session is still web-verified with the same account (not expired, revoked, signed out or switched off) and still those owners' admin, and otherwise ends the change as stale. That General receives a plain-text notice (no mentions). It also asks again that a General the chat card could go to is still there. The boundary this moves: the second confirmation becomes the account's **one** authorization of that session (#1939), held until it is revoked, expires or the session ends — not a per-Apply proof that the account holder is present. Anyone driving that verified session (an unattended signed-in browser, or someone holding its session cookie) confirms the same way; signing out or revoking the authorization (Settings → Access & security → **Revoke web authority**, or **Not me** on the DM card) ends it. The public link, guests, unverified sessions and the host's ownerless `agend web` session never qualify, and a change that needs host CLI confirmation still does.

If the affected connection cannot safely receive the prompt, AgEnD tries another world's General, then requires local `agend settings confirm <id>`. That command uses a separate same-user Unix socket (0700 parent, 0600 socket); agent environments are refused. It prints the authoritative source, requester and diff before an interactive confirmation or explicit `--yes`. There is no HTTP/MCP confirm route. Setup before a fleet exists uses the same host confirmation; a pending response never starts the fleet.

Revocation, expiry, shutdown or a changed baseline prevents new effects. An admitted operation retains its resource leases through actual settlement and conditional cleanup; it may remain `applying` while native work settles. Rollback restores only still-owned fields, preserving later edits. Intentional final session revocation can return a completion receipt but cannot authorize further effects. Pending requests disappear on restart, so submit again. This boundary does not defend against another process running as the host user; independent filesystem edits are detected where possible, rather than claimed to be atomic.

## CI supply chain (#2528)

GitHub Actions used by this repository are pinned to full commit SHAs, so a
moved tag cannot change what CI or the npm publish workflows run. A CI job
fails the merge gate if any remote `uses:` is still a tag. Dependabot's
weekly `github-actions` updates rewrite the SHA and the trailing tag
comment together (patch/minor grouped; each major its own PR). See
[CI coverage — GitHub Actions pins](ci.md#github-actions-pins-2528).

CI verifies npm registry signatures of the root and `website/` install trees
(`npm audit signatures --json`). Invalid signatures fail the job; missing-only
findings are reported. See [CI coverage](ci.md#npm-registry-signatures-2528).

Pull requests into `main` and `release/**` run GitHub's dependency review:
high or critical advisories, and licences outside the allow-list, fail the
check. See [CI coverage](ci.md#dependency-review-on-prs-2528).
