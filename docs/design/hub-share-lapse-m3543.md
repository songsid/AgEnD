# Hub share lapse after a backend or folder change (M-3543)

## The rule that stays (#3147)

A Fleet agent's Hub token is `sha256(["agend-hub-agent-v2", agent, incarnationId])`. The incarnation id rotates when
the agent's fingerprint `[backend, working_directory, runtime, machine_id]` changes. A share's consent stores the token
it was given for, so consent never carries over to a different backend or folder. M-3543 keeps this rule and only makes
the lapse visible.

## What happens today (M-3542)

After `/backend` (or a Settings save that changes the fingerprint):

- the Hub still lists the agent as shared;
- the Fleet refuses to act for it: `local(agent)` is null in `hub/compose/member.ts`, so the room tools answer a bare
  `unavailable` and room asks are not delivered;
- nobody is told.

## Proposal

### 1. One local test: `shareLapsed(agent)`

The test is true when the agent has a **published** exposure **and** its consent row names this agent **and**
`agentToken(agent)` is non-null **and** differs from `consent.token`. A missing link, no share, or a missing token stays
what it is today. Only this one case is "lapsed".

The test runs on the member side only, with no Hub change. It lives next to `local()` in `hub/compose/member.ts` and is
exported for the fleet.

### 2. The tools say why (acceptance 2)

`hub_room_list`, `hub_room_post`, `hub_room_members`, `hub_people_search` and `hub_set_intro` return
`{ ok: false, code: "share_needs_reshare", message: "Your Hub share lapsed when your backend or folder changed. Ask the person to share you again on the Hub (My shared agents)." }`
instead of `unavailable` when `shareLapsed` is true.

This is Fleet-local and needs no Hub change. Agents that branch on `code` keep working: `unavailable` and `stale` are
unchanged for every other case.

### 3. The person is told when it happens (acceptance 1)

When the incarnation rotates, the fleet checks the published exposures. That happens in `observeHubAgentIncarnations`
(a config save, including `/backend`) and in the lazy `hubAgentIncarnation`. For each published exposure whose
`shareLapsed` turned true:

- a **Needs you** item, once per agent and rotation: "Mira's Hub share needs to be shared again: its backend changed
  (codex → claude-code). Open the Hub's My shared agents." It links to `/ui/hub` and is cleared when `shareLapsed`
  turns false;
- the chat answer to `/backend` gets one line with the same text, when that agent is shared.

There is no General message: the Needs-you item is the durable place.

### 4. The share row is marked (acceptance 3)

- **Fleet side (no Hub change):** the Fleet's Hub sharing list (Settings → Hub, and the agent's Details) shows
  "Needs re-share" (zh-TW 「需要重新分享」) for a lapsed agent.
- **Hub page (needs a Hub-side field: this is the decision point):** the catalog the Fleet publishes deliberately
  strips `incarnation`. To mark the row on the Hub's 我分享的 Agent page:
  - **(A, recommended)** add an optional `lapsed: true` to a catalog row's `exposure`, sent only when the Hub
    advertises a new capability (`agent-catalog-lapse-v1`). The Hub UI shows "Needs re-share" with the Share action.
    Older Hubs (the Mac pilot, until it upgrades) get the catalog exactly as today.
  - (B) No Hub change: the person is told only on the Fleet (Needs you, Settings, `/backend`). The Hub page keeps
    showing the agent as shared until it is re-shared.

## Open question to verify while building

Does the Hub page's Share action re-share an agent whose exposure is already published, issuing a new consent with the
current token? Or must the person stop sharing and share again? The user's M-3542 re-share answers this. If it is
stop-then-share today, the "Needs re-share" row offers that as one action. A re-share is still a person's consent,
never automatic (#3147).

## Tests

- `shareLapsed`: lapsed, never shared, no link, no token, and the same token (control).
- Each tool's code.
- The Needs-you item appears on a backend change of a shared agent and not of an unshared one, and clears after a
  re-share.
- The catalog `lapsed` flag only with the capability (A).
- A real-app capture of the Fleet mark and (A) the Hub mark, with a user-look HOLD.
