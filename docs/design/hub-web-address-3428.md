# Hub web-address operation (#3428)

繁中摘要：主機擁有者可在這台電腦的登入工作階段準備並確認 Hub 網頁位址變更。先檢查 HTTPS 位址、指定的監聽介面、連接埠及憑證，再透過共同設定寫入器提交。提交後，原有 Hub 網頁工作階段結束，使用者在新位址重新登入。Hub ID、issuer、member 位址、member 憑證及配對保持不變。Settings UI 依決策 0a464323 暫緩，待 Hub UX 審查方向確定；本次先完成後端。

## Authority and preparation

The fleet-origin routes `/api/settings/hub/web-address`, `/prepare` and `/commit` consume the existing `hubSetupSession` proof. Only the exact host launch session on a direct local connection passes D3. A directory administrator, chat-code session, header token, guest, forwarded request or public link does not substitute for the host owner. Authentication precedes lazy controller construction; body reads, certificate generation and bind probes retain the same current session/configuration binding.

Preparation accepts a bare canonical HTTPS origin, one explicit listener, and `keep`, `generate` or `import` certificate intent. Wildcard binds and member/preview conflicts refuse. Import accepts write-only PEMs, not a browser-selected file path. Generation/import reuses the initializer primitive; the final writer checks SAN, validity, key match and the full TLS context again. Private keys never appear in the summary, receipt or HTTP response. The candidate and one-use reference expire after five minutes and belong to one host session.

Only changed web/derived-preview endpoints are probed. The member listener is never rebound merely for a probe. An unchanged, currently owned listener can be retained. The candidate is probed again immediately before entering the synchronous writer; owner/configuration and TLS selection are rechecked after each await. DNS and socket probes retain existing deadlines and cleanup. Probing is not an atomic transfer of a socket to the next TLS server: a later bind race is handled as saved-but-unavailable, never reported ready.

## One decision and recovery

This is an internal `webAddress` operation of `src/hub/settings-commit.ts`, not a second config writer. Rename journal v1 and directory journal v2 retain their formats. Web-address journal v3 is only a recovery index.

1. Verify the current full sealed image and selected TLS material/revision. Stage immutable private certificate/key files, the exact next config, signed manifest and receipt. Flush files and newly created ancestor directory entries through the owned AgEnD home. No setting is in force yet.
2. In one existing-Hub root SQLite IMMEDIATE transaction, recheck the exact actor/image/selector, append the required audit, save the operation hashes, reset the browser TLS selector to the newly sealed initial files, end existing Hub sessions, retire unissued company-join browser bindings/nonces and unconsumed invitations, and advance the independent web-address head.
3. The SQL head immediately fences the old mounted generation, including sign-in calls already waiting for LDAP. This does not advance the directory epoch or alter member authorization/pairing state.
4. Install the exact manifest/config through the fleet's existing writer, verify the seal and material, retain the receipt, then remove the journal/staging index. The runtime performs its existing fenced, confirmed-close-before-replace remount.

Recovery opens existing state only, checks the complete migration/floor/identity set and consults the SQL operation. No SQL decision means the original pair must still match before private preparation is discarded. A committed decision resumes exact file installation. Files that match neither image, a newer SQL head, changed material or a different TLS selector refuse without overwriting them. Completion never repeats session invalidation, audit or the decision. A new login after successful completion therefore survives a later cleanup/recovery retry.

The sealed `hub.webAddress` record is derived `{operationId, revision}` metadata, not a user setting. It binds the config to the SQL decision. Mount checks both that record and the web-only field/material hash; later legitimate rename, directory edits and certificate selection remain possible. A config/manifest restored without its matching address SQL state cannot silently mount. Older initialized Hubs omit this field and retain their old digest. The new required SQL component prevents an older server binary from ignoring this authority state.

Crashes before the journal leave the old sealed pair unchanged; immutable, unselected private preparation may remain on disk. No listener or credential is exposed from it. Every journal/install boundary has an injected-crash test. These are logic/durability-error tests, not executed power cuts.

## Company-join delivery and old browser flows

A request that already issued a credential or committed an ACK may still be recovering a lost response on the Fleet. Changing its web identity would strand that key-bound recovery. The final SQL transaction therefore refuses with `busy` while an `issued` or `acknowledged` request remains within its original ten-minute outer deadline. It never extends that deadline. This also covers a lost ACK response; the Hub cannot infer that the Fleet made its local journal active merely from the Hub's ACK commit.

After that window, issued records, receipts, keys, Fleet credentials, provenance and original retention fields remain untouched. Unissued requests lose their browser binding and become terminal where appropriate. Unconsumed invitations are deleted with exact-row checks, not falsely marked consumed or rewritten with a different signed expiry. An expired invitation may outlive its normally pruned request; only that absent expired history is tolerated. A missing live request or a retained row inconsistent with its consumed flag still refuses. Old challenge nonces are retired. These changes share the address decision transaction and roll back on any refusal. Returning from A to B to A therefore does not revive an old flow cookie, invitation or challenge. Existing paired member connections retain their member endpoint, SPKI and credential.

## Outcome and rollback

A successful commit returns `ready` only after the exact current configured Hub reports readiness; an intentionally stopped Hub returns `off`. A post-decision bind/start failure keeps the coherent saved setting and returns `saved_unavailable`. The old origin is not reopened automatically, and old sessions/database state are never restored as compensation. The host dashboard remains the independent repair surface.

To restore a previous address, submit a new host-owner operation with the prior address and suitable certificate. Revisions advance and current security state is preserved. Do not restore an old database merely to recover a URL. Binary downgrade must respect the required component/backup rules. No firewall, DNS, host trust store, issuer key, member credential or real directory is changed by this operation.

The UI remains on hold. Its later proposal will use the approved minimal field/confirmation direction and explicitly say that people sign in again. Before that UI is reviewed, provide the requested real-shell EN/zh-TW desktop/phone evidence and the user-facing zh-TW wording to the leader. #3429 member-address migration and re-pairing are separate work.

## Evidence scope

The owned-container backend rehearsal is `scripts/manual/hub-web-address/run.sh`: real Chromium, the host's real D3 route, production Hub HTTPS, verified synthetic LDAPS, and a second FleetManager's real pairing API/member runtime with no Agents. It checks new-address reachability/fresh login, old-session and old-address refusal, and reconnection with identical member credential/pins. The committed PNGs and source-hash-bound receipt are technical backend evidence. They do not approve or implement the held Settings UI, and do not substitute for its later EN/zh-TW desktop/phone/SKEW matrix.

Provisional zh-TW text for the held UI: 「Hub 網頁位址」; 「變更後，Hub 網頁需要重新登入。已配對的 Fleet 不需重新配對。」; 「確認變更」. A finishing company sign-in should say 「有裝置正在完成登入，請稍後再試。」. These strings are a review note, not a shipped UI or a request to add another step.
