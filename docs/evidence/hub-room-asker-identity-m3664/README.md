# Negotiated Hub room asker identity — M-3664

Base: `3ed153b1541f020aa027781f905a615b2d3e63df`, release/2.3.5-alpha. Design: [hub-room-asker-identity.md](../../design/hub-room-asker-identity.md). All fixtures use synthetic identities, owned temporary state and inert delivery callbacks. No live Hub, directory, Fleet, account, model or browser campaign.

Review refinements and staged validation are in [R1](review-r1.md), [clock-warning refinements](review-r2.md) and the final [stable retention bound](review-r3.md). Original-run logs/mutations are retained historical evidence at the initial head.

## Change and consumer boundary

Room asks currently carry only a displayed name. The optional `room-asker-identity-v1` signs the immediate author id/kind and exact projected payload using the pinned Hub issuer. Old peers retain their wire and ordinary room answers; verified identity is absent. Agent/on-behalf display projections remain agent identities. Room workers/application posts are explicitly scoped assistants. There is no owner or body fallback.

A separate encrypted, bounded private companion records first admission, exact legacy commit and expected agent/exposure/incarnation. Prepared companion → legacy commit → committed companion must finish before input/getter exposure. The unchanged strict legacy journal contains no new field or migration component. Missing/invalid/wrong-destination/expired provenance returns null. Accepted historical identity survives transport-proof expiry and answered/acked/restart; it grants no current consent, authority or active turn. M-3661 still owns and must separately integrate actual-input/boot/turn provenance and relay restrictions.

`HubMemberFactoryOptions.attachRoomAskers` exposes the bound getter. The ordinary server-owned delivery also carries the frozen snapshot and exact destination/message binding before input; no tool or prompt parsing is involved.

## Validation

- Affected run: **216 distinct tests / 12 files passed across scoped stages**, including actual TLS hello/welcome and real HTTP/SQLite room routing, member composition, old room answering, strict protocol codecs and four old/new peer combinations. The existing single fallback sends modern20 then the exact legacy16 offer; no retries/timeouts were added.
- The initial affected run was214/12. A final source review added the authenticated answered-delivery path for agent-answer handoffs (these have a delivery receipt rather than a room.post operation). Its2 new controls plus the affected agent suite passed32/2; the other paths carry unchanged.
- The actual member composition test signs through its pinned fixture issuer, receives the snapshot through TLS, checks the attached getter, answers, closes, then reopens the same selected state through an identity-free consumer while the separate companion remains present.
- The old selected-state opener, strict legacy schemas/authenticator and database registry implementation are byte-equal to base; `legacy-bindings.json` records reproducible extraction boundaries/digests. These are actual unchanged reader functions, not a claim of running an installed older binary.
- New controls cover all actor kinds, operation-backed on-behalf projections, application principal scoping, malformed/ambiguous actors, signed fields, payload/context/files/brief changes, key/Fleet/link/exposure binding, first-admission expiry, retained lookup, quotas, corrupt/missing schema refusal, duplicate conflicts and both crash boundaries.
- Four production mutations are retained as patches with exact before/after input digests: skip Ed25519 verification → 1 assertion red; remove expected destination check → 3 red; bypass prepared-phase input guard → 1 red; substitute human owner/person for operation-backed agent → 2 red. Each run exits1 from failed assertions. Sources were restored exactly; restored targets passed70/4, with the final answered-source extension restored11/1. Test types and full build/postbuild exited0.
- The first signature mutation survived because the original forged signature had invalid base64url encoding. The fixture now uses a canonically encoded forged64-byte signature, so the assertion specifically binds Ed25519 verification. The final restored target run supersedes that assertion; unaffected controls carry from the214-test run and the scoped answered-delivery delta. Counts are distinct tests, not summed repeat runs.

## Risk and rollback

The critical risks are misclassifying a projected person post, exposing a partially committed identity, or making rollback reject the selected database. Actor-operation checks, exact two-phase binding, explicit capability intersection and the separate encrypted file address these. A damaged companion refuses startup rather than resetting provenance. Capacity refuses new signed admission instead of evicting unexpired work. An orphan yields no historical identity/input until an exact legacy commit. R1 permits a safe prepared-only correlation rebind when the adapter proves no legacy row, preserving the original subject/payload/destination/admission/deadline. Historical lookup never revives an interrupted turn.

Rollback uses the old name-only room path and ignores the companion outside the selected state set. No live state was modified. Already captured labelled work must retain its immutable consumer provenance; downgrading it into owner work is not supported.
