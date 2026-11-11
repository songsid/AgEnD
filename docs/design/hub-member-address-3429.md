# Hub member-address operation (#3429 backend)

繁中摘要：主機擁有者可準備 Hub 傳輸位址變更，確認前取得受影響 Fleet 清單。提交會保留 Hub ID、issuer 及 TLS 金鑰，必要時重發符合新主機名稱的憑證，撤銷舊連接憑證，並留下給各擁有者、Hub 管理員及主機的持久通知。UI 暫緩；後續統一使用「重新連接」，使用者只需要看到瀏覽器的「Hub 位址」。

## Scope and vocabulary

Read #3658 at `94abbb6e71a203a890eba761d37ba9c4e698963a`, §§4 Phase A/recovery/wording and A.6, before defining projections. Public action names use Connect / 連接, Remove connection / 移除連接, Revoke / 撤銷 on the Hub, and Reconnect / 重新連接. Technical member origin belongs to host-only configuration/advanced diagnostics. No UI controls or new click sequence are built here; the owner has not yet approved the whole UX proposal.

#3615 provides existing exact-binding Disconnect and recovery guidance, not an atomic reconnect API. #3644 permits a new company Start after a definitely unissued expiry, while unknown issuance remains blocking. This backend will not clear TOFU, silently follow a changed identity, delete an ambiguous company journal, re-publish withdrawn Agents, invent a prior Fleet label or infer that two Fleet rows belong to the same computer. The report's old-row supersession would require a separate proof/quota change; it is not implied by this address operation. Existing explicit local identity repair and fresh company sign-in remain the recovery authority.

## Prepared change and one decision

Consume D3's exact host launch session, owner object/authority epoch and current continuation. Accept a bare HTTPS member origin distinct from the web origin, with an explicit non-wildcard listener. Probe changed candidate endpoints without binding the running web listener or preview. Capture the full sealed image, identity material, member-address head and transport state. Return the affected active credential-bearing Fleet IDs, owners and available labels before the one confirmation; no fresh directory fan-out or synthesized people.

Keep the issuer files, Hub ID and TLS private key/SPKI unchanged. Version only the member certificate: legacy identity v1 selects its fixed certificate; identity v2 atomically selects an operation-owned immutable certificate plus its new origin. Every reader uses one validated snapshot. A port-only move may retain certificate bytes; a new hostname requires a matching SAN certificate using the existing private key.

The shared sealed-settings writer owns a distinct member-address operation/journal. Stage exact private material, selected identity metadata, next config, signed manifest and receipt and flush ancestor entries. The single root SQL decision uses one transport mutation to revoke old active credentials, increment generations/global revocation version, retire old pairing codes/claims and incompatible company browser flows, and retain the operation, complete notice recipients and required audit. Existing transport floor semantics remain fail-closed: an advanced independent floor without the SQL decision is uncertainty, never a reason to reset the floor or reopen old credentials.

An independent member-address head fences old mounted pair/claim/connect/browser continuations before files/remount. Unchanged Hub web sessions can read their notices after remount; session continuity confers no enrollment permission. Issued/acknowledged company delivery retains the same original ≤10-minute protection as #3428.

## Completion and recovery

Install the atomic identity selector, manifest and configuration only against the captured before/after images. Cold recovery may read the internally coherent selected identity without imposing the temporarily old config origin, but must match its hashes to the exact SQL operation before writing. Normal mount still requires exact configured origin, selected certificate/key/SAN, issuer/Hub ID and the derived member-address marker. Third images, missing/newer decisions, changed key/material or a raised unmatched transport floor refuse without overwriting.

After the decision, failure is saved-but-unavailable, never a restore of old credentials or a reopened old endpoint. Rollback is a new forward operation to the previous address, with fresh generations/revocations; never an old DB/floor restore. Cleanup durably removes the journal before its staging inputs.

## Notices and future reconnect

Persist one bounded operation notice with exact owner/admin/host recipients in the same transaction as revocation. The unchanged Hub web origin is the reliable read/ACK surface; old revoked sockets cannot guarantee delivery. Reads do not ACK; pagination reaches retained history, ACK checks exact recipient independent of the current page, and owner projections contain only their affected Fleets. Notifications do not grant enrollment or supply a credential.

Expose `reconnect` as the future recovery action, carrying only the already-known browser-facing Hub origin, plus an exact operation/Fleet identity. The future held UI may combine existing local actions, but it must preserve old trust, use fresh company identity/policy/quota checks, and stop if identity differs. No unsigned relocation or automatic trust reset is added. Until the UX/core recovery design is approved, existing explicit local repair remains available and is rehearsed as such; this backend makes no one-button UI acceptance claim.
