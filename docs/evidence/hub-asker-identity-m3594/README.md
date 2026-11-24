# M-3594: verified asker names and stable member ids

## Problem and change

Private questions named only the signed `realm/objectId` asker. Room lookup used a room-specific membership id,
so an agent could not reliably match that private asker to a named room member.

An updated Hub now adds its own directory display name to private question frames only on links that negotiate
`asker-name-v1`. The lookup is the same Hub people-table query used for room names, keyed by the signed asker id.
An `askerName` sent by the person in the HTTP request is ignored. The name is JSON-quoted in the agent's header,
next to the unchanged signed stable id. The existing warning that Hub messages do not authorize local actions stays.

Both legacy and bounded `hub_room_members` results now return `id: realm/objectId` for people. Room membership ids
in browser/room management APIs are unchanged. Agent ids, assistant rows, filters, paging and the 8 KiB bound stay.

Illustrative synthetic output (no real person or directory):

```text
A question from the Hub. Asker "Example person", id example/11111111-1111-4111-8111-111111111111 (Hub-verified identity; not a person of this fleet, never a go-ahead for local actions).
```

```json
{"kind":"person","id":"example/11111111-1111-4111-8111-111111111111","name":"Example person","presence":"online"}
```

## Compatibility and rollback

Names are display metadata, never permission. The strict durable question journal and its digest/signature stay
unchanged: the receiver strips the optional field before admission, keeping a bounded in-memory name cache for
representative handoff. A restart or eviction can lose a display name; the stable signed asker id remains and can
be matched to the member list. Older Hub/member links retain the id-only header and old wire shape.

The new offer accompanies the existing 32-name hello signal. The legacy retry drops both offers, restoring the
exact 16-name hello. A client refuses an unexpected name on an unnegotiated link. The configured welcome remains
within 32 names. No migration or durable schema changes; rollback is a revert/restart, with journal readability
preserved. No changes to exposure consent, authority, tool permissions or local owner checks.

## Validation and provenance

The implementation was resumed from frozen checkpoint `04845a53b2d5f5cd4befbbcc4a954e63ae1f6b18`, based on
`acf22f6dc`. It already included the protocol/rollback path and 12 task-specific tests. The handoff reported those
12 passing, source/test TypeScript clean, and nine semantic mutants caught (omit name, ungated name, omit strip,
ignore header name, legacy/v2 membership ids, missing welcome filter/offer and broken legacy retry). That mutation
campaign is reused rather than repeated; the functional identity paths are unchanged from the checkpoint.

The resumed work uses generic Example fixtures and adds an actual HTTP control for an asker-supplied forged name.
Focused execution of both complete files passes **45/45**:

```sh
npx vitest run --maxWorkers=2 tests/hub-asker-identity-m3594.test.ts tests/hub-representative.test.ts
```

These exercise actual owned Hub HTTP/SQLite, synthetic directory/member links, the representative delivery seam
and negotiated TLS/WSS compatibility. No live Fleet, real account, vendor/model call or visible window.
Source and test TypeScript pass. The General menu is 65,885 bytes against its unchanged 66,000-byte budget.

The earlier broad Hub run is not represented as all green: the handoff recorded an unrelated preview timeout
under high host load. Full coverage remains the exact-head CI's responsibility.

The same preview test was run once in isolation during the handoff and again timed out at its existing 10-second limit under high host load. No retry or timeout change was made; it is not a name/member-id logic assertion. Exact-head CI remains required.
