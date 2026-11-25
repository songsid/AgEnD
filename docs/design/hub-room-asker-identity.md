# Negotiated room asker identity (M-3664)

Design baseline: release/2.3.5-alpha at `3ed153b1541f020aa027781f905a615b2d3e63df`. No product implementation yet. M-3661 owns turn provenance, labels, relay restrictions and continuations. This card supplies authenticated room-request identity; it never grants authority or opens a turn.

## Wire and negotiation

Add `room-asker-identity-v1`, requiring `welcome-caps-v1` and `room-ask-v1`. It is a modern hello offer only when the Fleet's verifier/companion is composed. Enable it only in the hello/welcome intersection, never because the Hub advertised it alone. Add it to the Hub's modern-only welcome filter and the member's existing legacy-hello exclusion set. The current composed modern hello grows from 19 to20 names; the existing single bounded pre-welcome fallback still sends the exact legacy16-name offer. No new retry, timeout or truncation. Old Hub/new Fleet and new Hub/old Fleet continue the old wire and ordinary answering behavior; they do not acquire labelled room relay support.

Keep `asker:{name}` intact. A negotiated room.ask may additionally carry `askerIdentity`:

```ts
{
  v: 1,
  issuer: HubId, issuerKeyId: Sha256,
  destinationFleetId: FleetId,
  messageId: MessageId, roomId: RoomId,
  exposureId: ExposureId, exposureRevision: Epoch,
  linkEpoch: Epoch,
  subject: { id: string, kind: 'person'|'agent'|'assistant', displayName?: string },
  contentDigest: Sha256,
  issuedAt: Millis, expiresAt: Millis,
  retainedUntil: Millis,
  nonce: string, signature: string
}
```

`messageId` is the room delivery UUID, not the parent post or reply UUID. Bound subject id/name lengths and total proof bytes (2 KiB); normal frame and assembled-prompt limits still apply. Sign a domain-separated fixed-order tuple with the existing pinned Hub Ed25519 issuer. The content digest covers the canonical validated legacy ask, including routing, display name, text, context, attachments, context-state and brief after negotiated projection. Use a dedicated bounded canonicalizer, not the unrelated 64 KiB tool-arguments limit. Tests pin key-order independence and every signed field. The proof is added at dispatch, not to the legacy retained payload.

At admission verify canonical schema/signature/base64url, pinned issuer/key, current authenticated pairing/Fleet/link, destination exposure/revision, exact payload digest, nonce and fresh time bounds (same 120-second maximum as the existing asker signature). `retainedUntil` is separately bounded by the delivery/work deadline and a 24-hour maximum. It is historical-provenance retention, not an authorization lease. Never interpret the sharing owner or a displayed name as the asker.

Proof on an unnegotiated link or a present invalid proof is refused; it is never stripped and silently accepted as verified. An absent proof remains an ordinary legacy room ask, but yields no verified identity and M-3661 must refuse labelled pass-through. This also preserves safe ordinary handling of legacy retained work whose original actor cannot be proved.

## Who is the asker?

Resolve the immediate authenticated source from immutable Hub post/operation records, not projected display fields:

- Person: the authenticated directory principal for a direct post/button click; use the existing full realm/object id. `person` describes that principal class, not proof that someone physically typed a message or approved a local operation.
- Agent: the published source exposure bound to the authenticated Fleet/member operation (or the exact answered delivery receipt for a room-answer follow-up); id `exposure/<uuid>`. This remains an agent even when an on-behalf receipt makes its displayed post look like a person. Do not read `HubRoomPost.onBehalfOf` as identity proof or substitute the human owner. Personal-agent exposures use this same kind/id namespace.
- Assistant: an explicitly identified non-person Hub worker. Room assistant id `room/<roomId>/assistant`; poll-result automation id `room/<roomId>/poll`. These do not borrow the original person's id. Authenticated MCP-application posts are assistant work, id qualified by application id and its authenticated principal, with the recorded application label; they cannot masquerade as a direct person post.

Names come from the corresponding authenticated directory/exposure/application/worker records and are signed as presentation only. Id/kind remain distinct through all mappings. Unknown, ambiguous or missing actor records do not produce a proof or a person fallback. Existing room authorization and consent checks remain unchanged.

## Durable member seam and rollback

The existing member ask and saved journal schemas are strict. Do not add fields to those encrypted legacy rows. A separate authenticated companion binds the exact accepted delivery/payload digest, pairing, receiving agent/exposure/incarnation, verified subject and admission time. One compact row per retained delivery; bounded fields, fixed row/byte quota and expiry aligned with accepted work retention. Expired terminal entries may be collected; active/unexpired entries are not silently evicted. If capacity prevents retaining a supplied proof, refuse that admission visibly rather than losing provenance.

Use a separate private companion SQLite file derived from the existing pairing/room binding and encryption key. Adding a component to the old main database would make older `applyHubMigrations` reject the entire state as newer, so that is not the rollback path. Older code ignores the separate file outside its selected state-set manifest; compatibility tests must run the actual old opener with that extra file present. The optional capability is offered only when the verifier/store is usable. A corrupt companion is reported and never silently replaced; it yields no verified provenance, not an invented person or authority. A two-phase admission writes prepared companion → legacy ask commit → committed companion; no dispatch/accessor availability until both are committed. Recovery verifies exact matching retained ask before completing a prepared row; orphan or mismatched data never yields identity. Conflicting duplicate payload or subject cannot overwrite the original. Refreshed transport signatures for the same immutable logical delivery do not change its accepted subject/digest, refresh its daemon-recorded original admittedAt, or extend retainedUntil. No supplied timestamp can backdate first admission.

Signature freshness is checked when accepted. Historical lookup authenticates that acceptance against its stored admission time, while the companion's independent retention expiry still returns null. Answered/acked entries remain readable within that bound. This is not a claim of current consent or active execution. M-3661 captures the minimal snapshot before actual input, and retains it in its own accepted work/delivery provenance for later continuations; it does not need our row forever.

Consumer contract agreed with Sentinel:

```ts
type VerifiedHubAsker = Readonly<{
  hubId: string; id: string;
  kind: 'person'|'agent'|'assistant'; displayName?: string;
}>;
// Server-owned caller/destination binding is mandatory, not supplied by a tool/body.
verifiedAsker(messageId, expectedDestination): VerifiedHubAsker | null;
```

The getter checks the authenticated accepted journal/companion match and expected destination/incarnation. Missing, invalid, legacy, wrong-destination, evicted or retention-expired entries yield null; never text/name/correlation/owner inference. It does not depend on the question still being open. It neither opens nor revives M-3661's volatile boot/turn scope. M-3661 room relays remain fail-closed until this capability is merged and integrated; proof availability alone does not enable them.

## Acceptance and limits

Use isolated fixtures only: four old/new peer combinations, actual legacy16 fallback and strict parsers, valid person/agent/assistant/application/poll actors, same-name/different-id, signed-field/body/file/context tampering, issuer/destination/revision/link/expiry mismatch, forbidden on-behalf/owner/body fallback, missing/unnegotiated proof, prepared/committed/crash/duplicate/restart behavior, answered/acked getter, destination mismatch, retention/quota and unchanged baseline room answering. Pin no new authority or active turn. Meaningful reversals must fail assertions. Run affected tests, test types and build; leave full suites to CI. No live Hub/account/model or new security campaign.

Risk: misclassifying a projected person post, silently dropping identity, or making rollback refuse old state. Explicit actor resolution, negotiated signing, separate durable storage and fail-closed access address these. Rollback restores the old name-only path and ignores the companion; it must not relabel an already accepted labelled delivery in M-3661 as owner work. That consumer durability boundary remains M-3661's responsibility. Public examples/evidence use synthetic ids only.

## Implemented consumer ports

`HubMemberFactoryOptions.attachRoomAskers` supplies the bound historical getter. The server-owned `HubRepresentativeDelivery` additionally carries `verifiedHubAsker`, `roomAskerMessageId` and a frozen `roomAskerDestination` when the exact companion is committed. Legacy delivery omits these fields. This lets the turn-provenance consumer capture the authenticated snapshot before actual input; no string parsing or user-supplied destination is needed.

The accepted destination contains agent, exposure id and `incarnation = SHA256(JSON.stringify([accepted lifecycle token, accepted room conversation generation or null]))`. The companion also binds the immutable legacy tuple `[ask, local consent/revision/token, correlation id, generation or null]`. Mutable answer/state/ack fields do not change that binding. A proof arriving after a legacy admission cannot retroactively label that earlier input. Fresh re-signing of the same accepted subject/payload/deadline is permitted without rewriting the original proof or admission time.

Composition advertises the optional capability only with a usable member store/verifier and a server router's explicit identity-support port. The existing modern-hello signal and bounded legacy retry remain unchanged. The getter conveys historical identity only; M-3661 still owns actual-input/current-turn provenance and all relay restrictions.

## Review refinements

The immediate author's parent-post record must agree with the delivery's accepted asker/member/source relation before signing. Direct people and application posts require the exact person member/principal; operation-backed or answered-delivery agents require the source exposure and member; poll/assistant workers require their original closed-poll/answered-call permission-principal binding. A mismatch produces no verified author, while ordinary room handling remains unchanged.

There are exactly three person-looking `service.insert()` callers: authenticated HTTP posts, authenticated button clicks, and the operation-backed agent on-behalf projection. Application posts use the first path but atomically write their application companion; without that table the transaction cannot commit the person-looking post. Product migrations do not drop it. Web guests cannot pass `requirePerson`; personal agents use the agent path, and the room assistant writes `assistant`, even when working for someone. The callsite inventory and actual missing-application-table rollback are pinned in tests. An on-behalf agent's `via_name` is its frozen display label, not the projected person's name.

Authenticated freshness failures now produce a bounded EN/zh-TW Needs-you diagnostic: check this computer's and the Hub's clocks (or a late arrival), no input has occurred, and the Hub retries. Forged/unbound timestamps cannot create that diagnostic; proofless legacy asks gain no time check. The normal delivery deadline is created24h after enqueue. The signer additionally clamps retainedUntil to min(delivery deadline, delivery creation+24h), including overlong persisted deadlines. The bound is frozen per delivery; the reconnect control advances an hour and passes the reissued proof through an existing companion without changing its original retainedUntil. Retention expiry also fences first input, not only historical lookup.

Expiry does not erase a partially committed or otherwise nonterminal input barrier. Collection requires a freshly authenticated legacy read proving terminal work or no legacy row; absent state is not inferred from a missing companion. A prepared orphan with no legacy row may take the retry's new correlation binding while preserving its original verified subject/payload/destination, admittedAt and retention deadline. Committed or mismatched records cannot be replaced.

A key change selects a new binding/store. Historical rows remain readable only through the old pinned issuer and old encryption binding, within their original retention (at most24h); they are never adopted by a newly paired key or used to revive a turn. The `assistant` kind deliberately covers three non-person classes: `room/<id>/assistant`, `room/<id>/poll` and `application/<id>/principal/<principal>`. M-3661 may use these stable id prefixes to distinguish their presentation, but all remain assistant provenance with no human-owner substitution or authority.

The clock diagnostic itself expires at the signed ask deadline. The existing Needs-you refresh prunes expired in-memory warnings, including after clock rollback, without another proof or a new timer. Clock warnings do not offer the representative's retry action: the Hub retries its own delivery. Both strings live in the shared typed locale table (`hub.room.clockSkew`).
