# Hub sharing foundation (M-3294 / S-170)

The existing Hub knows only published exposures, so it cannot draw an owner's unshared agents. This slice adds a separate owner-only catalog receiver, an injectable Fleet catalog adapter, bounded request DTOs, and the approved design. It does not activate production Fleet collection or remote sharing. S-171 adds the visible Settings switch, notice and Undo before connecting the Fleet adapter; S-172 adds the Hub page. Each starts from the dev tip after its predecessor merges.

## Result and scope

- Catalog rows contain instance/display names, one-line description, emoji/colour, kind, General marker and eligibility. General and ClassicBot rooms are included. Windows exec rows are disabled using the ordinary delivery restriction. Private folders, CLI configuration, tools, history and lifecycle tokens are excluded. A local incarnation contributes only to the opaque revision digest.
- The default-on `hub_member.share_from_hub` contract is parsed strictly. Off produces an empty snapshot without enumerating agents. Its production Settings control and adapter activation are deliberately delivered together in S-171.
- The Hub stores the catalog separately from shared exposures and serves it through `GET /hub/v1/me/agents`. A fresh real cookie session, exact immutable owner, active Fleet generation and current directory epoch are required. App-shaped contexts and other administrators cannot substitute for the owner. Removal purges the retained metadata; disconnect retains it as last known.
- Hub-only `agent-catalog-v1` is offered only to a member already able to accept the larger welcome. The member opts in locally and sends after reconciliation. The report then enables Hub-to-member refresh on that exact connection. Hello remains 16/17 names with the existing update-only fallback.
- `exposure-request-v1` is never offered, every catalog says `requests:false`, and request/result sends are refused. These schemas cannot activate the share writer. Existing Settings confirmations, contact limits and ClassicBot private delivery are unchanged.

The catalog is bounded to 128 rows, 128-byte instance names, 256-byte display names, 512-byte descriptions and the existing 256 KiB frame ceiling. Over-limit complete catalogs are refused rather than silently truncated. The revision includes local incarnations, so replacing an agent with the same visible name changes it.

## Verification

Linux, Node 22.22.2, isolated local fixtures. No live Fleet, directory, vendor API, browser or installed package was exercised.

| Packet | Result |
|---|---|
| Initial protocol controls on the old source | 3 assertion failures |
| Initial owner-view controls before the receiver/route | 2 relevant assertion failures; the third was a removal-fixture URL corrected before final verification |
| Final focused suites, including real FleetManager projection and mounted factory | 32/32 in 6 files |
| Existing protocol, composition, ClassicBot, exposure, migration and group consumers | 95/95 in 7 files |
| Final explicit report-opt-in transport hardening | 10/10 in 2 files; overlaps the focused packet |
| Catalog-specific upgrade/idempotence/older-registry control | 1/1, 4 unselected |
| Source / test native TypeScript | 0 / 0 diagnostics |
| Owner filter, incarnation digest and mounted switch reversals | 3/3 selected assertion failures; exact source restored |

There are 128 distinct passing cases across the focused, migration and existing-consumer packets. Later transport runs are not counted again. The reversible controls run selected cases only; they are not full-suite mutation runs.

`hub-share-link-m3294` uses the actual member factory, pinned TLS/WSS, the actual Hub HTTP receiver and SQLite/audit. It proves catalog-after-reconcile ordering, owner read, refresh, fence, off-without-enumeration, unmounted requests, local opt-in and strict old-peer hello fallback. Its listeners use the existing leased-socket helper. All test services and listeners are closed.

Commands:

```sh
node node_modules/vitest/vitest.mjs run tests/hub-share-model-m3294.test.ts tests/hub-share-member-m3294.test.ts tests/hub-share-catalog-m3294.test.ts tests/hub-share-fleet-m3294.test.ts tests/hub-share-link-m3294.test.ts tests/hub-fleet-hooks.test.ts
node node_modules/vitest/vitest.mjs run tests/hub-protocol.test.ts tests/hub-compose-member.test.ts tests/hub-classic-share-m3285.test.ts tests/hub-exposure-api-s3c.test.ts tests/hub-sharing-pause-migration.test.ts tests/hub-groups-mount-s89.test.ts tests/hub-fleet-versions-link-m3136.test.ts
node_modules/@typescript/native/bin/tsc --noEmit
node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
```

The compressed logs retain the before, after and selected reversal results with workspace paths redacted. The source/evidence digest list uses separate `path` and `sha256` fields. The private scratch harness and binaries are not committed.

## Upgrade and rollback

The Hub adds the independent `s3-agent-catalog` version-1 component in the normal atomic migration registry. Existing exposure/grant rows are not rebuilt. An older migration registry refuses the added component instead of silently opening newer state. Old Fleets retain ordinary sharing and receive no new frame. A new Fleet facing a strict old Hub uses the existing one-time fallback, then sends no catalog.

Before upgrading a Hub, keep its ordinary quiesced whole-state backup, including keys and floors. Keep the newer binary while this database is current; an intentional rollback uses the matching pre-upgrade binary and complete saved state. Do not delete migration records or lower independent floors. This packet checks the additive migration through existing upgrade/idempotence/refusal consumers; it is not a packaged live downgrade rehearsal.

S-171 must keep requests frozen for ten minutes, repeat their exact ID/payload on uncertain outcomes, and provide durable notices before mutation acknowledgement. Only Undo automatically restores a retained ask list; a normal re-share starts with nobody and offers the earlier list. The final Hub page and its desktop/phone PNGs belong to S-172.

## Plain sync before review

Source commit `11c7f2754` was merged with alpha `8e0d0ee03` as `1ff45e971`. Every own added/removed line is identical; applying the original patch in an isolated index reproduces the entire merged tree. Only FleetManager auto-overlaps, in separate hunks. `sync.json` records the proof. Source digests in the manifest bind the tested stage before that sync; no local verification was repeated for unchanged own code. The following evidence/changelog commit changes no runtime or test source.
