# Classic room contact authorizations

A group room can relay requests to a worker agent with broader standing permissions.
Restricted mode holds non-administrator contact requests before any worker input,
wake, forwarding grant or ordinary delivery admission. It does not authorize the
worker's subsequent shell, data access or changes. Action-scoped brokers are later work.

## Contract for the first slice

The TypeScript wire contract is `src/contact-auth-types.ts`. Dates are ISO UTC.
All routes use the dashboard's existing authenticated request and write protection.
Guest and agent-token callers cannot manage permissions or decide applications.
The server resolves actor identity; JSON actor fields never establish authority.

| Route | Result |
| --- | --- |
| GET `/ui/api/instances/:name/contact-permissions` | `ContactPermissions` |
| PUT `/ui/api/instances/:name/contact-permissions` | `ContactPermissionsWrite` → `ContactPermissions` |
| GET `/ui/api/contact-authorizations` | `ContactTicketPage`; optional agent, person, status, cursor filters |
| GET `/ui/api/contact-authorizations/:id` | `ContactTicket` |
| POST `/ui/api/contact-authorizations/:id/decision` | `ContactTicketDecision` → `ContactTicket` |

Permission reads are scoped to managers; ticket reads are scoped to approvers
and authorized source-room administrators. Lists never reveal other rooms' requests.
Writes require the observed revision; stale writes return 409. Refused identities
return 403, unavailable stores 503. Each list is bounded to 50 rows.
The person filter is an exact server-issued identity key, never a fuzzy name search.
The UI may display server labels but must preserve the whole returned identity.

An approved application binds its exact arguments, origin, source and target
generation, expiry and result recipient. Approval creates at most one durable
outbox delivery. A lost confirmation is unknown, never permission to resend.
Broadcast creates separate applications and reports each target's outcome.
`report_result` cannot be used as an unapproved new contact. A proven return on
approved work reuses only its authorized return path, not a correlation string alone.

The topmost human origin is carried by server-owned work records across relays,
later turns, schedules, retries and restart. Mixed or unavailable origins do not
become administrator work merely because the latest message is from an admin.
The Hub contact-window refusal remains prior to this gate; its approved answer
path is unchanged and no application can waive the Hub limit.

New Classic rooms explicitly start restricted. Existing rooms with no field stay
legacy. The room setting, Needs you and General may recommend the same switch,
but neither reading nor ignoring a notice changes policy. Native CLI coverage is
reported separately: ready, restart-required, not-covered or failed. Tool filtering
and CLI hooks are policy controls, not an OS boundary against same-user processes.

Restricted rooms retain public read-only search and web fetch by default. Admins
may add exact MCP tools per room. A tool using the owner's API key or account
shows a cost and identity warning without revealing the credential. Shell,
filesystem outside the room scratch and owner credential access remain off by
default. Before a legacy room switches, its suggestion lists current tools that
would stop. Public reading is not synonymous with unrestricted network or shell.

## Implementation seams

A1 owns origin, policy, persistence, decisions and server adapters. A2 consumes
this contract for Permissions, Authorizations, badges and notices. A3 consumes
`ClassicChannel.restrictedMode` and `CLASSIC_RESTRICTED_TOOLS`, owns the CLI guard
module and launch hooks, and returns `ContactGuardStatus`. Unknown coverage must
never be shown as ready. All shipped paths enforce the same tool ceiling at call
time, independently of what a model's cached tool menu shows.
