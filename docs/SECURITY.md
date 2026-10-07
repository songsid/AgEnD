# Security Considerations

Running coding agents remotely through Telegram or Discord gives chat participants a way to request actions on the host. AgEnD's chat permissions, MCP tool permissions and HTTP credentials protect different entry points; they do not sandbox the coding CLI.

Paths below use the default data directory, `~/.agend`; `AGEND_HOME` can select another directory.

## Chat access and administration

An admitted user can ask an agent to read files, change code or run commands, subject to the backend's permissions. Treat those users, their accounts and any admitted bots as trusted with the agent's workspace and host access.

- Use an explicit `access.mode: locked` and a small `allowed_users` list to restrict fleet chat access. **Omitting the entire `access` block falls back to open.**
- Persisted access mode overrides YAML; persisted and YAML user lists are unioned. Removing a user from YAML alone may not revoke access. See [configuration](configuration.md#channelaccess).
- Fleet administration requires an explicit entry in the receiving adapter's YAML `allowed_users`. Open access or pairing approval alone does not grant that role. ClassicBot has its own admin and chat allowlists; see [permissions](permissions.md).
- Enable account 2FA and protect bot tokens. `tool_set` is enforced on AgEnD operations at the server; it does not restrict the backend's own shell, filesystem or network tools.

## Permission bypass (`skipPermissions`)

For Claude Code, **bypass is enabled by default**: AgEnD passes `--dangerously-skip-permissions` unless `skipPermissions` is explicitly `false`. The flag bypasses Claude's tool permission prompts, so an admitted chat request can lead to host actions without an individual approval.

Set `skipPermissions: false` to omit that flag and use Claude Code's own permission configuration. AgEnD does **not** generate a shell allowlist or a destructive-command denylist. Configure restrictions in the CLI's supported user/project settings, and use OS isolation when you need a host boundary.

The per-instance `claude-settings.json` is generated again on startup (including the status line and bypass-warning acceptance when applicable). Do not use edits to that generated file as a persistent security policy.

## IPC socket

The daemon communicates with the AgEnD MCP bridge over `~/.agend/instances/<name>/channel.sock`. AgEnD uses a restrictive umask and attempts to set the socket to `0600`. It creates private instance directories with `0700` and tightens eligible existing directories. There is **no shared-secret handshake**. These filesystem permissions separate Unix users; they do not authenticate or isolate processes running as the same UID, or protect against root. Check warnings when permissions could not be restricted.

## Dashboard token and browser session

The dashboard credential is a fleet-wide bearer token in `~/.agend/web.token` (created with mode `0600`). It persists across fleet restarts; permission tightening on an existing token file is best effort. `agend web-token rotate` replaces it; old dashboard URLs, header tokens and derived session cookies fail on subsequent authorization checks. Rotation is not a promise to retract an already authorized request or close every existing connection.

For routes behind the dashboard gate:

- A matching URL `?token=` on GET/HEAD is exchanged for an `agend_session` cookie and a redirect without the token. A URL token alone is rejected for writes.
- The cookie contains a derivation of the token, with `HttpOnly`, `SameSite=Strict` and a browser `Max-Age` of 12 hours. The server does not independently enforce a 12-hour cookie expiry. `Secure` is added when `X-Forwarded-Proto` reports HTTPS; use TLS for remote access.
- A valid cookie or `X-Agend-Token` header authorizes the gated routes. An invalid `Origin`, or one whose parsed host/port differs from `Host`, is rejected; the scheme is not compared, and callers without `Origin` are accepted when their credential is valid. This is a shared operator credential, not a per-user account or role system.

Protect dashboard links and cookies as credentials: the initial token-bearing URL can still appear in browser history, proxy logs or terminal output. `/dashboard` requires a fleet admin, but anyone who obtains a valid credential can use it; chat allowlists are not rechecked for each HTTP action.

## Public reads and the Host guard

**The web token does not protect all HTTP reads.** `/view` and its GET APIs, including `/api/pane/<instance>`, profiles, avatars and sort order, are public to anyone who can reach the listener with an allowed `Host`. `/api/ai-usage` is also public when enabled, and GET `/health` needs no token. Pane captures can contain commands, credentials and other private output.

`/view` profile/avatar/sort-order writes have their own token check: they require `web.token` via `X-Agend-Token` or `?token=`, not the dashboard cookie. They bypass the general dashboard gate and its Origin check; its GET/HEAD URL-token exchange should not be assumed for these routes.

The health/dashboard listener binds to `127.0.0.1`. Every request, including public reads and `/agent`, must pass the `Host` allowlist: `localhost`, `127.0.0.1`, `[::1]`, configured `hostname`, and names in `web.allowed_hosts`. Missing, malformed or unlisted hosts get 403. The login terminal listener also uses a Host allowlist.

This check limits DNS rebinding from a browser. It is **not authentication**: an ordinary HTTP client can choose an allowed `Host`. If a proxy or port forward exposes the listener, protect public reads at that boundary and add only host names you intend to serve. A `/login` terminal has a separate per-login credential; its temporary public tunnel is not a tunnel to the dashboard. See [login configuration](configuration.md#finishing-a-login-away-from-the-machine-public-link).

## Agent HTTP token

`POST /agent` bypasses the dashboard gate and requires `X-Agend-Instance-Token`, checked against the claimed instance's `agent.token`. The daemon writes a fresh token on each CLI spawn, with mode `0600`; permission-restriction failures are logged and do not necessarily stop startup. The server also enforces that instance's AgEnD tool permissions. A web token is not a substitute for this token. As with the IPC socket, a process running as the same Unix user can read the credential; this is not isolation between mutually untrusted local agents.

## Secrets storage

Bot tokens and API keys are stored in plaintext at `~/.agend/.env`; `web.token` and per-instance `agent.token` are plaintext credentials too. Filesystem permissions restrict access but do not encrypt these files.

Minimal `agend export` includes `.env` when present; a full export can also include other credential files. The gzip tar archive is not encrypted, and the command warns about secure transfer. Protect exports and backups as credentials. Consider filesystem encryption if the host is shared.
