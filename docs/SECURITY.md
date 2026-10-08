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

The local CLI/header credential is `~/.agend/web.token` (created `0600`). Browsers use random, server-side sessions obtained with a five-minute, single-use code. Old URL tokens cannot sign in. Cookies are `HttpOnly` and `SameSite=Strict`; writes require a matching Origin and per-session CSRF value. Local cookies expire on the server at 12 hours / two hours idle. Token rotation invalidates subsequent requests, but cannot undo already admitted work.

The General `/dashboard` menu is admin-only and secret-free. Its link and code go by DM, with an awaited Discord ephemeral fallback; Telegram failures ask the user to `/start` the bot privately. Local scripts can use `X-Agend-Token`; the managed public gateway rejects that header and local cookies/codes. Public credentials are scoped to the current exposure; old or unbound gateway sessions fail closed before touching idle lifetime.

## Temporary public gateway and local reads

An explicit owner-adapter General admin action may open the managed public link for two hours (configurable 1–480 minutes, fixed from consent). Only pinned/checksum-verified cloudflared is used, in the same one-tunnel lane as `/login`. The listener is separate and carries code-owned provenance, not a trusted proxy header. Only the current exact public HTTPS Host and reviewed panel routes are accepted; no wildcard is added to the local Host list. `/view` and usage reads require public sign-in even if local reads are open. Health, agent, issue-code, SSE, preview and legacy restart endpoints are not exposed.

Public cookies are Secure `__Host-` cookies and bind one exposure. Every public login needs a confirmed 🔐 public notice in the owning General within five seconds, regardless of `notify_login`; the candidate is neither usable nor persisted before confirmation. Code leakage can still grant full web-admin access. Cloudflare terminates TLS; forwarding a link alone does not sign in, but reveals the endpoint to guessing and shared-breaker denial of service. Exact Origin plus CSRF protects browser writes; Host checks are not authentication. Expiry, disable, private close, revoke, owner/binding loss and shutdown close access and withdraw public credentials before child cleanup. An unconfirmed child stop blocks another tunnel.

Local `/view` reads remain open by default (`view_access: session` closes them), including terminal captures that can contain secrets. Local profile/avatar/sort-order writes require a session or header token. The local listener's Host list is localhost, loopback, configured hostname and `web.allowed_hosts`. A proxy or port forward configured by the operator does not gain the managed gateway's rules automatically. Existing local sessions do not become public credentials. See [web dashboard](web-dashboard.md#temporary-public-link-from-a-phone).

## Agent HTTP token

`POST /agent` bypasses the dashboard gate and requires `X-Agend-Instance-Token`, checked against the claimed instance's `agent.token`. The daemon writes a fresh token on each CLI spawn, with mode `0600`; permission-restriction failures are logged and do not necessarily stop startup. The server also enforces that instance's AgEnD tool permissions. A web token is not a substitute for this token. As with the IPC socket, a process running as the same Unix user can read the credential; this is not isolation between mutually untrusted local agents.

## Secrets storage

Bot tokens and API keys are stored in plaintext at `~/.agend/.env`; `web.token` and per-instance `agent.token` are plaintext credentials too. Filesystem permissions restrict access but do not encrypt these files.

Minimal `agend export` includes `.env` when present; a full export can also include other credential files. The gzip tar archive is not encrypted, and the command warns about secure transfer. Protect exports and backups as credentials. Consider filesystem encryption if the host is shared.
