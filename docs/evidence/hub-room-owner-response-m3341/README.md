# Room owner response — M-3341 A2

The owner can choose an already shared agent on Invitations, add it to the requested room, or decline. Unshared agents remain disabled and link to My agents. The owner can stop new requests without closing existing ones.

The approved spec is [the room-owner request flow](../../design/hub-room-ask-owner-for-agent.md). The [API and activation notes](../../design/hub-room-owner-requests-api.md) describe protected retention, versioned authority inventory and rollback.

## Evidence and limits

- Initial owner-detail test failed with 404 before implementation (`validation/a2-before.log`).
- Six affected backend files: 244/244 pass. Seven supplemental files: 148/148 pass. Commands and counts are in `validation/`; counts are separate runs, not a claim of distinct tests.
- Real factory controls use the ordinary migration registry and HTTP entry: pending encrypted hint plus audit anchor survive one-day retention; a replaced provider refuses the purge; expiry releases protection; a missing port refuses composition before listeners.
- Four reversals are caught by assertion failures: allow an unpublished target, delete protected ciphertext, remove the protected audit-anchor stop, and include private hint references/digests in authority inventory. Source was restored after each control. See `controls.json`.
- Real headless browser: 60 checks and 16 PNGs covering EN/zh-TW, desktop/phone, one eligible agent, multiple choices, no shared target and the owner's setting. Browser checks also exercised real accept, decline and opt-out writes, no one-to-one grants, no load alerts and no foreign requests. The eight principal originals were inspected for wrapping, glyphs, alignment and synthetic-only content; the singular-person sentence and repeated destination link were corrected and retaken.

The browser uses an owned HTTPS listener, SQLite, encrypted audit and shipped UI modules. Only its inert directory and synthetic publication frames are supplied by the rig. It does not run a real Fleet process, CLI, model or account, and makes no Windows or operator-browser changes. Disposable certificate trust is limited to the isolated browser context. The separate factory tests cover production registration and retention wiring. The source base, changed-source digest and served asset hashes are in `browser.json`.

Run the browser harness with Linux `CHROME`, `PW_DIR` and `CJK_FONT` paths; then run `tsx scripts/manual/hub-room-owner-requests-m3341/owner-browser.mts`. Browser homes, certificates and pages are closed and deleted in `finally`. Images and receipts contain only fake people, names and IDs; local test paths are replaced with `<worktree>` in public logs.

## Upgrade and rollback

The additive request schema is registered in the normal Hub plan. A hard downgrade needs a full pre-upgrade Hub backup restored with the older binary. A compatible rollback build can remove the browser feature and public routes while keeping the schema and private provider that protects pending hints; no configuration switch is claimed. Historical role cutover markers keep their original bytes; new request-aware inventories use representation v2 without changing the outer v1 marker or the role migration registry.

A4 findability is a later slice. A5 Fleet forwarding remains parked. No request-only notification transport is introduced.
