# Hub page-load request map

Static assets are omitted. Feature-dependent cards may omit their requests.
`GET /hub/v1/session` carries capabilities; there is no separate capabilities GET.

Every signed-in shell starts these reads:

- `/hub/v1/session`, `/hub/v1/rooms?v=2&ownerRequests=1`, `/hub/v1/me/prefs`.
- One shared `/hub/v1/rooms/events?notices=3` SSE; its first snapshot includes pairing notices.
- `/hub/v1/teams` and `/hub/v1/teams/settings` when the Teams sidebar entry is enabled.

Sources: `panel-hub.js:133–160,398–406,541`; `hub-room-favorites.js:67–97`;
`hub-client.js:365,463–466`; `hub-teams.js:43–46`.

| Page | Additional reads on load |
| --- | --- |
| Home/chats | Normally opens the latest room, using the room flow below. New-chat launcher reads `/exposures`, details of up to five recent group rooms, `/me/welcome`, and `/me/fleets` for the version banner. |
| Rooms list | Uses the shared `/rooms?v=2…` response; there is no second group-only list request. |
| Room, including modern 1:1 | `/rooms/:id`, `/rooms/:id/messages?limit=50`, group `/rooms/:id/pins`; then `POST /rooms/:id/read` when visible. Shared SSE remains open. |
| My agents | `/exposures`, `/pairings`, `/me/agents`, `/me/welcome`; feature-dependent `/join/metadata`, `/me/personal-agent`, `/invitations`, `/me/intro-notice`. |
| Notifications | Pairing notices arrive on the shared SSE. Feature-dependent `/me/intro-notice`, `/security-notices/directory?limit=25`, `/roles/notices`. `/notices?v=3` is a fallback, not an additional normal initial GET. |
| Admin overview | `/admin/dashboard?range=7d&timeZone=…`; repeats every 60 seconds. |
| Roles | `/roles`; selecting Audit adds `/roles/audit`. Picker searches are interaction-driven. |
| People | Same `/roles` response. Switching tabs or opening a person uses local data. |
| Connected Fleets / Manage | `/admin/overview`; its mounted cards can add another `/session`, `/admin/company-join`, `/admin/enrolment-codes`, `/admin/personal-agents`, `/teams`, `/admin/rooms/creators`, `/admin/rooms`, `/admin/assistant`, `/admin/session-limits`, `/admin/recommended-version`, `/admin/hub`. |

All paths in the table are relative to `/hub/v1`. Sources:
`panel-hub.js:652–701,1088–1133,1333–1436`; `hub-room-thread.js:259–271,392,559`;
`hub-my-agents.js:28–37`; `hub-quick-pairing.js:169–176`;
`hub-admin-overview.js:100–108`; `hub-roles.js:47–76`.

The client serializes GETs through `readTail` (`hub-client.js:280–282`). Component
`Promise.all` does not imply parallel HTTP reads. The combined server CPU below
is therefore useful for interpreting page waits, but is not a wall-clock SLA:
feature flags, cached creation hints, coalescing, TLS, network and rendering all
change the actual load time.
