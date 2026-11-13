# Rooms R/C/A/U integration checkpoint

Source `5ca70231b519db8ee3c24aacc6046116ddeeef4c` on `integration/hub-rooms-rac-u`. This is a WIP checkpoint, not a merge gate or full S-142 acceptance. Public R3/R4 remain drafts. The packet names all consumed peer heads and binds the relevant source, UI, script and tests.

The actual R HTTP/SQLite dispatcher and C durable adapter communicate over pinned TLS/WSS. One inert agent input produces a durable answer; its first Hub ACK is dropped, the link reconnects, C retries its frozen answer and receives ACK, and SQL retains one answer. A's actual service/runner supplies both room and admin ports: configure/read/usage, plain private ask, group context, disabled warning and physical Stop drain are exercised with an inert worker. Final78/78 across10 suites includes these and existing C composition, room, directory, admin and migration controls. Earlier72/7 and19/4 overlap. Both native programs exit0;465 fragments and whitespace pass.

The U1 list/thread/composer and U2 NewRoom run against actual room API responses, without an API response fixture. The browser first exposed array-vs-object DTO mismatches: candidates lacked `{candidates}`, owner agent rooms lacked `{rooms}`, and creator GETs lacked names. Three actual-HTTP assertions were red before correction. Those fixes are being carried into public#3866. Two stale U2 GET path fixtures were corrected privately; the owner carried a query-insensitive variant in80e733111. Earlier phone harness assumptions (hidden first sidebar row; Enter-to-send on touch) were corrected to visible rows and the shared send button, with no corresponding product change.

Final browser:16 judged checks,8 original PNGs, desktop EN/light and phone zh-TW/dark. It covers the list, complete direct-group count, room creation, never-signed-in membership, a persisted human message and the exact private assistant answer. There are no page errors or horizontal document overflow. A bounded independent image inspection found no clipping/overlap/readability blocker; the members header emoji is a small hollow glyph in this headless environment. NewRoom is explicitly mounted in a component harness because the U1 WIP shell does not mount it yet. The list, group thread and private assistant use the actual shell. The directory and physical worker remain inert; no production Fleet, account, AD or model CLI is used. Cookie/CSRF material is absent from receipts, and generated TLS keys are removed at teardown.

Remaining: concrete C invitation/Team services and production factory injection, the U shell mounts/settings callbacks, and Lumen's complete real-server workflow walkthrough. Current ordinary parent-first review, final resolution review and exact-head CI remain. This checkpoint does not finish S-142 or full Track R. Coordinator alone merges.

## Revision1: actual shared-shell mounts

See [r1/README.md](r1/README.md) and its bound receipt: source `7ce5d52798704ca3000b313a30bc7d1da111c5ef`,106/15 focused, both native programs0,38/38 actual-browser checks and12 original PNGs. It replaces the NewRoom component harness with the real sidebar action and adds actual room settings/admin walks. Earlier packet remains historical and untouched.

Administration order is consumed separately in [admin-order.md](admin-order.md), with33 focused UI checks. Existing revision1 screenshots retain their original source binding.

## Revision2: all three PM follow-ups combined

[r2/README.md](r2/README.md) records source `5706f1a98c6c72fc0faf210a77f2791cc2920326`:51 focused UI checks plus the overlapping final23-case A slice,45/45 real-browser checks and16 refreshed original PNGs. It consumes admin order, signed-in copy and Name/Save alignment together; previous gallery bindings remain historical.
