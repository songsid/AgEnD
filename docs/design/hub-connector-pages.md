# Hub connector 4c: app pages and remote setup

This completes the browser surface for the direct Hub MCP door in #4060. A colleague needs only their app's HTTP MCP configuration and the Hub's trusted HTTPS address. No local AgEnD process, package or proxy is part of the connection.

The person menu opens **My AI apps** / **我的 AI App**. It provides the canonical `/mcp` address, separate Claude Code, Codex and generic setup prompts, connection dates, consented scopes and immediate disconnect. Prompts contain only a URL and configuration syntax. They carry no token, account configuration, local command or certificate bypass.

The OAuth redirect opens a company sign-in followed by the actual consent page. The three requested capabilities start checked: reading shared rooms, posting there and asking currently allowed agents. A fourth answer-inbox capability remains visibly unavailable for a later step. The page identifies the signed-in person, explains person-via-app attribution and provider disclosure, and labels the app-supplied name as unverified. Allow and Cancel return only to the already validated OAuth destination. A changed request, sign-out or retired read cannot reuse a previous consent screen or redirect.

Administration → This Hub contains the default-off AI-app switch and the existing common AD-group/team/person picker. The narrow suggestion endpoint is administrator-only, bounded to twenty validated results and thirty requests per minute, and fences the administrator and directory image across its await. It works before app access is enabled. It does not broaden app directory access. Pure policy widening retains app grants; narrowing ends them as described in the door design.

Room managers have a default-on **Allow AI apps to read and post** switch. The existing room DTO and dedicated policy writer remain authoritative. The room's coalesced app-rate-limit system line is translated by the viewer's language. The browser-only `mcp-apps-v1` feature is offered with the mounted pages, and is never a member hello capability.

Two JavaScript modules are appended once to the Hub serving inventory. The stylesheet is served separately as `text/css` and loaded lazily. The pages use shared layout, token and picker primitives. Existing role, personal-agent, room-list, composer, assistant and Fleet member negotiation paths retain their own authority.

Step 1 deliberately limits `hub_room_*` to shared rooms. Direct agent questions use `hub_agent_list`, `hub_ask` and app-private `hub_ask_result`; neither browser nor other-app direct history is exposed. The Hub assistant and Hub General remain excluded. Connecting or disconnecting an app does not grant administrative or approval authority.

## Verification and operational limits

The actual-page fixture serves the real Hub HTTP services, SQLite and audit over HTTPS, with an owned directory and inert answering member. Linux headless Chromium trusts only the fixture's authority in an isolated NSS home. Missing trust and wrong hostname controls refuse. There is no `ignoreHTTPSErrors`, user trust-store change, live Hub/Fleet/AD or Windows window. The preferred evidence uses English desktop and zh-TW phone views; the phone-only font retake changes no product source.

Native app interoperability is a separate leg: the installed Linux Claude Code and Codex binaries run in disposable client containers with URL-only remote MCP configuration, native no-browser OAuth and a few short real calls on our own accounts. Only account authentication files are copied into isolated homes; personal MCP/configuration/skills are not inherited. The test authority and DNS alias exist only inside the owned rig. The server fixture uses an owned Docker network because Docker Desktop host networking is separate from the WSL loopback namespace.

The public evidence records each stage rather than claiming a packaged systemd Fleet, desktop-app UI, real directory or full production listener factory test. Rollback removes the page feature/mounts and serving entries; the compatible parent auth/door schema and retained connection history remain. Disabling the administrator switch first ends app access. A user-facing Hub requires a certificate already trusted by the app; no self-signed trust shortcut is offered.

## Consent destination and retired sessions

Browser preview returns only the selected redirect origin (no path, query or OAuth secrets), derived from the retained authorization request. Consent prominently shows the HTTPS origin, or an app on this computer with its loopback host/port. The app-provided name is never treated as a vendor proof; the person must recognize the app and return address. No vendor-name heuristic grants trust.

Every new app browser read/write captures the page's session CSRF scope. The client refuses a retired scope before dispatch, while component lifetime fences still retire late results. The room toggle uses the same captured scope. No bearer/native MCP token is accepted at these browser methods.

My AI apps uses an explicit paste hint for Claude Code/Codex, an address-only instruction for other apps, primary Copy address and the shared manual-setup disclosure. A right-aligned Disconnect and compact permission/date summary fit the app row on phones. All administrator choices are disabled with the switch off; the policy warning explicitly says narrowing ends every existing app connection.
