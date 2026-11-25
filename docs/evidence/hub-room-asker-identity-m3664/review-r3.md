# Persisted retention bound after reconnect

Prism closed the original expiry-GC input barrier at30becd25, while finding that `min(delivery expiry, send time+24h)` moved the bound on an injected48h delivery: reconnecting an hour later produced a different retainedUntil, which the existing companion correctly refused as a conflict.

The signer now uses the immutable delivery creation time: `min(delivery expiry, delivery createdAt+24h)`. Transport issuedAt/expiry remain fresh per send; historical retention stays fixed for that delivery. The companion's subject/payload/destination/deadline immutability checks are unchanged. Normal enqueue already creates a24h deadline; the defensive cap now also remains stable for an overlong persisted record.

The actual HTTP/SQLite/signing regression now persists the first proof into a real encrypted companion, advances the fixture clock by one hour, reconnects with a new link epoch, and passes the reissued proof through actual existing-record prepare. It fails first with `Hub protocol: conflict` under the moving cap and passes after the creation-time cap; retainedUntil and the historical subject remain unchanged. The existing application-ledger rollback control now asserts the precise missing-table cause after the clock advance.

Scoped source/companion controls passed25/2. The before-input patch applies to6efb73e3 with `git apply --unidiff-zero`; the recorded source/test digests bind that red control. Lumen R2 A/B/C is included in the same push with its own34/2 proof and locale/expiry/no-Retry scope. R1's other cleared signature, actor binding, orphan and input-barrier paths carry. No broader/native/browser/provider campaign was repeated.

Final test types and full build/postbuild exited0. The companion immutability check was not weakened.
