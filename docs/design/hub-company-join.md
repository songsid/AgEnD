# Company-account Fleet connections

Implementation of [#3423](https://github.com/songsid/AgEnD/issues/3423), including its security-reviewed §§2A–2C. This is alpha-only and off by default. The per-person group maximum remains eight.

## Use

A configured Hub administrator starts at **Administration → Allowed groups and people**. The leading card contains the company-account Fleet connection switch; **Manage group permissions** opens the separate group editor. **Copy colleague connection link** copies the exact server-supplied address and identity descriptor; copying creates no invitation, pairing offer or grant. Group permissions must grant `pair_fleet` for automatic connections. The public link explains how to open the person's own Fleet Settings; it neither signs in nor enrolls anything.

In the Fleet's real **Settings → Hub**, enter the company link or the Hub's HTTPS web address, name the Fleet, and choose **Sign in with company account**. The initiating host operator's own current loopback session folds local consent into Start, including on a chat Fleet. Other local admin sessions use the existing General/authenticator confirmation; company sign-in never supplies that local authority.

A separate tab shows the exact Fleet address. Submit **Sign in and connect Fleet**, or explicitly **Connect as …** for an existing Hub session. The normal host-owned path takes two submissions and an optional Return navigation, with no administrator action per Fleet. No Agent is shared automatically. Once the pinned member link is ready, the existing connection card owns status, sharing and disconnect.

An eligible person without group permission can receive a short-lived **Invitation exceptions** link. Issuance records the exact configured administrator and immutable recipient, and is that invitation's approval. The recipient still signs in and the Fleet still provides its local consent and key proof. The same leading card contains these existing individual Fleet-connection exceptions; they grant no chat or Agent-sharing permission. Existing manual pairing codes remain under **Advanced**, which opens automatically when a confirmed request awaits administrator approval. Their checks are unchanged; a failed company discovery never silently downgrades to them.

## Trust and authority

- Browser discovery uses normal HTTPS CA validation. Public metadata authenticates the exact Hub ID, web/member origins, issuer key and member SPKI. Machine proofs and credential delivery use only the pinned member TLS listener; browsers cannot turn their cookies into a machine proof.
- The Fleet and Hub web pages must use different hostnames. Ports do not separate cookies. The public company-link page suppresses its Fleet navigation link and shows setup guidance before a shared-hostname navigation can send cookies. Start refuses the same setup before discovery/pinning/push; Hub admission and restored local journals independently refuse it before any handoff. Use a distinct DNS hostname for the Hub, even when it runs on the same computer.
- A company link supplies an expected stable identity. A typed address pins first use before AD input, including unsuccessful attempts. An identity change stops before AD. **Replace saved Hub identity** is a separate confirmed local operation requiring a newly trusted descriptor; ordinary Retry cannot replace a pin or an existing binding.
- The Fleet owns its Ed25519 key, PKCE verifier, operation journal and exact local requester/confirmer capabilities. Only its original current cookie session can bridge, inspect an exact operation, recover or cancel. No-handle discovery returns only that session's operation. Header tokens, forwarded requests and Hub AD identity cannot create host authority.
- A Fleet-owned, `noopener` tab posts state to the Hub. The dedicated bridge requires one exact non-null browser Origin matching the registered canonical Fleet origin before consuming state, setting a flow cookie or offering AD. Hub sign-in and identity-submit keep their separate Hub Origin/CSRF gates.
- Automatic enrollment obtains a fresh group permit after the browser wait. Manual invitations obtain a fresh exact administrator proof and owner eligibility. New issuance shares the policy's physical directory-read pool (four/person, 32 total). Earlier sign-in, welcome projections and group unknown/off states are not an automatic allowance.
- One immediate owning-DB transaction combines consume CAS, retained-manual-plus-automatic quota, credential, provenance, required audit, sealed receipt and durable notices. Final session/directory-epoch, eligibility and permit fences run after audit. No directory await occurs inside that transaction. Manual issuance may exceed the self-service maximum; every retained manual Fleet counts against later automatic issuance.
- Issued requests keep their global 48/64 retained-claim admission slot through their original ten-minute deadline, including cancelled, expired-delivery and revoked results. Only genuinely unissued cancelled reservations release that admission slot early. This is separate from retained-Fleet ownership quota.
- Notices remain durable independently of audit. `pairing-notices-v2` carries explicit manual provenance. Old members and cached web clients receive only their understood group notices; manual rows remain queued and a v1-only link cannot ACK them. Exact owner/admin revoke remains unchanged.

## Delivery and local recovery

The Hub retains only the runtime credential hash in the Fleet row. Its bounded delivery receipt uses a dedicated private AES-256-GCM key at `hub/secrets/join-delivery.key`, a fresh 96-bit nonce and the complete authoritative resource/owner/key/provenance/deadline tuple as AAD. Recovery returns that exact credential after current session/resource checks, never another enrollment. Browser pages, URLs, storage, notices and audit receive no runtime credential or join verifier/private key.

| Boundary | Deadline or behavior |
|---|---|
| Outer operation | Immutable Start + 10 minutes |
| First redemption | Identity approval + 60 seconds, truncated by outer deadline |
| Issued delivery | Issuance + 2 minutes, truncated by outer deadline; the old 60-second deadline no longer applies |
| Local save | Intent/digest journal precedes the binding marker, profile and membership writes; file and every ancestor through private HOME must fsync before trust, first remote push or ACK |
| Crash between saves | Reconcile only the exact recorded marker digest and intended switch value, then recover the same key/result |
| ACK | Same key/verifier/operation proof, only after durable profile and journal; success activates the exact journal marker |
| Nonhost process restart | Require a fresh local confirmation for that same operation; status reads do not permanently revoke it |
| Cancellation or unknown issuance | Preserve key/journal and inspect the exact tombstone; no automatic fresh Start |
| Existing binding | Refuse before discovery/reservation; the existing exact Disconnect → Start over retires it before an explicitly requested new join |

A visible file after a failed directory flush is not proof of durability. Re-reading an existing pin, operation journal or current-operation pointer repeats the required ancestor flushes; a continuing failure holds the same operation and cannot become a fresh trust allowance on Retry.

An issued result that expires or loses delivery remains a retained Fleet and consumes quota. It is not shown as no creation. The UI offers inspection/revoke guidance and does not label saved-but-offline as ready.

## Validation and rollback

Focused tests are `tests/hub-company-join-*.test.ts`, the pairing-notice suites, existing group/composition/Settings suites and the Hub module import walk. `scripts/manual/mutation/hub-company-join.py` runs assertion reversals and restores every source in `finally`. `scripts/manual/smoke/smoke-hub-company-join.mts` boots an isolated Fleet and real sealed Hub with the production AD driver against a verified fake LDAPS wire peer. See the committed PNG receipt for exact versions, matrix and fixture limits.

To withdraw this entry, turn off **Company sign-in joining** in Administration. This ends its in-flight delivery attempts and preserves unrelated existing bindings, private pins, audit and notices. Keep the Hub DB, `hub/secrets/join-delivery.key`, transport/audit floors and Fleet private profile/journal/state together in backups. An older strict binary cannot read the new `company-join` DB component and does not understand the new local settlement marker: stop it and restore matching pre-upgrade Hub and Fleet private state before a binary rollback. Never delete pins or floors to make an old binary accept new state.
