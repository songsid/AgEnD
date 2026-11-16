# Hub connector for a person's own app — phase 4c (M-3240)

The Hub serves the remote MCP door directly at its HTTPS `/mcp` address. A colleague adds an address to their existing Claude Code or Codex MCP configuration; they install no AgEnD command, proxy or package. Company sign-in and consent happen on the Hub, and the app receives a credential for this Hub's person-facing tools only.

This implements [connector §7 row 3 / §10 4c](https://github.com/songsid/AgEnD/blob/9cf2a9edc/docs/design/agend-connector.md) and [Hub MCP step 1](https://github.com/songsid/AgEnD/blob/docs/hub-ux-review-m2902/docs/design/hub-mcp-agent.md). It builds on 4a's fixed, locally described MCP catalog and readable call-time refusals. The local `agend connect` owner socket and its four tools remain separate: a company token is never a Fleet socket credential, member credential, browser cookie, human approval receipt or administrative credential.

## Delivery slices

1. **Authentication foundation:** SQLite app grants, public-client registration, S256 authorization-code binding, consent selection, token rotation, fresh company-person/policy checks, disconnect and audit. This first PR exports the service and migration only. It mounts no endpoint, registers no production migration and offers no feature or setup button yet.
2. **Person-facing Hub door:** HTTP OAuth discovery/endpoints and Streamable HTTP MCP; the eight specified tools, existing person room/grant services, explicit app attribution, default-off administrator policy and default-on room permission. One mount owns the existing Core/room instances; it does not re-enter the browser HTTP API or Fleet tool dispatcher.
3. **Pages and acceptance:** My AI apps, consent and install prompts, administrator/room switches in EN and zh-TW, and one isolated headless real Claude Code/Codex journey with a test authority trusted only inside that rig. No live Hub, user desktop or trust override.

The Hub's own assistant conversation and Hub General are outside this door. It supplies no inbox/stand-in agent, administrative operation, change to sharing or room membership, file content, or `@all`.

## Authentication foundation

`HubMcpAuth` owns opaque pending requests, single-use authorization codes, app grants, and separate hashed access/refresh tokens. The HTTP layer will advertise the [MCP authorization discovery flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), public dynamic registration and S256; no client secret is copied into a prompt. HTTP token/discovery handling does not use a web session as a bearer token.

Registration accepts bounded app display metadata, never a claimed person. It accepts HTTPS callbacks and native-app HTTP loopback callbacks. Authorization checks the registered callback; only a loopback port may vary. The exact selected callback, client, S256 challenge and canonical `<webOrigin>/mcp` resource are retained through code exchange. State is returned unchanged. Pending requests live ten minutes; codes live one minute. Neither callback validation nor registration fetches a client URL.

The browser supplies the person through an existing, current company session. Consent may narrow the requested `rooms:read`, `rooms:post` and `agents:ask` scopes. The surrounding browser route must apply the existing same-origin and CSRF checks before approve/cancel/disconnect. A local-host repair session is not a company person. Client names are unverified display labels, not proof of an app vendor or administrator.

Each grant is bound to the immutable company person, this Hub resource and directory epoch. Its token context rechecks company eligibility and the live administrator policy, and fences app disconnect, policy changes, scope reductions, epoch changes and shutdown across awaits. `requireAdmin()` always refuses, even for a person who administers the Hub. Calls still use each existing service's person/room/grant checks; this context does not bypass them.

Access tokens last one hour. Refresh rotates a single retained refresh token and cannot widen the consent. A connection ends after exactly 30 days without use, when its account is disabled, when it loses eligibility under the app policy, or when disconnected. Temporary directory failure refuses use without permanently ending the grant. Logging out of the browser is independent of disconnecting the app. Limits bound public registrations, pending requests, active grants and live tokens; HTTP admission/rate bounds are added with the mounted door.

Connect, consent scopes, disconnect and automatic end are audited in the same transaction as the state change. Audit records contain no bearer/code/verifier, room text or question text. Audit failure rolls back consent. Existing current policy and identity fences protect the effect after any directory await; every token is checked again when an MCP tool runs.

## Product rules carried into the mounted slices

The three step-1 consent ticks start on. The administrator enables apps for joined people or selected AD groups, teams or people through the common picker. A room manager can disable app reads/posts while its room remains visible with the reason. Room reads return at most 50 messages, with member-join audience floors and quoted-data framing. Room posts display the actual person **via the consented app**, preserve person targeting of personal agents, and never manufacture a human receipt or Fleet on-behalf operation. Limit posts to five per person per minute and direct asks to thirty per hour. An ask returns its result within thirty seconds or a durable id for `hub_ask_result`.

## Evidence and rollback

Foundation tests use owned SQLite, existing Hub session contexts and an inert company directory. They do not prove a mounted OAuth/HTTP service or real CLI interoperability; those belong to the later slices. The initial fail-first check was a compiling conservative service scaffold refusing registration, not a failure on a released binary.

Before production registration this foundation can be removed with no deployment or schema effect. Once composed, rollback first disables the app feature and fences active grants, then keeps its schema and compatible token refusal behavior. Older binaries must not silently accept app credentials or treat them as web cookies. The person removes an MCP entry from their own app; AgEnD does not edit personal app configuration automatically.
