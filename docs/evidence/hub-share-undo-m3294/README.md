# Hub sharing actions and durable Undo (M-3294 / S-171)

The foundation could list an owner's agents but deliberately could not apply a share. This second slice connects the production adapter only alongside the default-on **Let me share agents from the Hub page** setting, a durable notice, and administrator-only 24-hour Undo. The final Hub checkbox page remains S-172, after this slice merges.

## Behavior

- The Hub accepts a frozen ten-minute request only from the connected Fleet owner's current browser session. The member compares that person with its stored owner and applies each row through the existing exposure writer. A journal receipt commits in the same transaction as the exposure change. Duplicate requests reuse the original UUID and body; an uncertain outcome is never called a definite failure.
- A durable web notice precedes any effect. The same notice is updated with partial results, and General gets one chat attempt with Undo. After a restart, Notices retains Undo for the full 24 hours; an old chat button explains where to find it. Later edits, replaced agents, changed ownership and expired requests are fenced. Undo skips changed rows rather than overwriting them.
- Stopping retains the earlier ask-list image for 24 hours. Only the exact Undo can copy it into fresh grants with their original expiry. A normal re-share starts with nobody. Old grants and direct conversations stay closed. Changed grants, freezes, sharing epochs and Fleet generations prevent restoration.
- Stops and Undo-share keep the existing answer fence. Pending direct and shared-room questions become not answered with the owner-stopped reason, including when intermediate snapshots were coalesced. No answer or history is released after withdrawal.
- Turning the Fleet setting off ends the owner catalog and new Hub-page actions without withdrawing existing shares or disabling local notice Undo. Individual Settings sharing still uses its existing confirmation. ClassicBot readiness, contact limits and private channel output are retained.

The request protocol uses the Hub-only `exposure-request-v1` offer and an explicit request-capable catalog report. It consumes no extra member hello slot. Catalog-only peers receive their previous shape and no new action frames. The design document records the exact request, result/ACK and Undo shapes and bounds.

## Verification

All runs used isolated local state on Linux. Counts below are staged and overlap; they are not added into one total.

| Scope | Result |
|---|---|
| Original writer / setting controls | 4 / 2 relevant assertion failures before their fixes |
| Final affected sharing, negotiation, composition, room and receipt suites | 198/198, 21 files |
| General callback success, admin/current controller, expiry and uncertain feedback | 4/4 after the callback-only correction |
| Skill, source scanner, locale and serving consumers | 51/52 initially; the only failure mistook internal `setMessage` state keys for UI copy |
| State-key naming repair plus UI behavior | 11/11; all displayed text still uses the locale layer |
| Source / test native TypeScript | 0 / 0 diagnostics |
| Three compiling selected reversals | 3 semantic assertion failures; exact source restored |
| Real dashboard desktop/phone journey | 22 checks; eight preferred PNGs |
| Existing Settings `GATE=ci` check | 124 checks |

The affected packet includes actual pinned TLS/WSS, the member factory, Hub HTTP, SQLite and real audit: a request is applied once, the result ACK is lost, the member restarts, and the durable notice still performs local administrator Undo. A crossing retry cannot consume the pending result ACK as a different RPC. Retention controls cover both ordinary and coalesced snapshots and the subsequent grant/owner/epoch/expiry fences.

The three selected reversals remove notice-before-mutation, the retained grant-image fence, and withdrawal settlement. Each compiles before its selected assertion fails. `reversals.json` records exact restoration. These are focused controls, not a full mutation campaign.

The final 198-case run precedes the General callback-only correction. Its four callback controls and final type checks cover that correction. The UI packet precedes only the internal setter rename and documentation; those do not change rendered text or behavior. Earlier fixture repairs and the initial locale-scanner failure remain disclosed in the private checkpoint; the retained before and after logs distinguish their stages.

Commands:

```sh
node_modules/.bin/vitest run tests/hub-share-*m3294.test.ts tests/hub-room-agents-r2.test.ts tests/hub-room-ask-progress-3126.test.ts tests/hub-s3b-server.test.ts tests/hub-chat-b.test.ts tests/hub-room-thread-3092.test.ts tests/hub-network.test.ts tests/hub-compose-member.test.ts --maxWorkers=1
node_modules/.bin/vitest run tests/hub-share-general-m3294.test.ts --maxWorkers=1
node_modules/.bin/vitest run tests/i18n-ui-literals-2390.test.ts tests/hub-share-ui-m3294.test.ts --maxWorkers=1
node_modules/@typescript/native/bin/tsc --noEmit --pretty false
node_modules/@typescript/native/bin/tsc -p tsconfig.test.json --noEmit --pretty false
# The repository's normal headless smoke runner invokes:
# scripts/manual/hub-share-undo-m3294/browser.mts
# scripts/manual/smoke-settings-ui-gate.mts with GATE=ci
```

## Preferred views and limits

`views/` contains desktop light EN and phone dark zh-TW, each showing the setting on/off and the shared/undone notice. The scratch dashboard exercised the actual Settings writer and admin Undo endpoint, backed by the canonical local exposure writer and journal. The eight originals were inspected after the final capture: no remaining visual blocker, overflow, page or CSP error. The General chat callback is covered separately by its four controls.

No live Fleet, directory, vendor/model API, Windows desktop, installed-package upgrade or downgrade was exercised. The browser runs were headless inside WSL; listeners and browser processes were closed and the shared slot released. The final Hub share-page journey is reserved for S-172.

## Rollback

Set `hub_member.share_from_hub` to false to stop new Hub-page work and catalog reporting; existing shares remain, and notice Undo stays available. Use the existing individual sharing switches for later changes. No new tool or role privilege is introduced.

The member and Hub add independent migration components; old strict registries refuse unknown components. Before upgrading, retain the normal quiesced complete state backup, including keys and independent floors. A binary rollback needs that matching state backup. Do not delete migration records, lower floors, or restore an old grant row to reopen history. This is an additive-migration verification packet, not a packaged rollback rehearsal.

Compressed logs have workspace paths redacted. The manifest uses separate `path` and `sha256` fields for file digests. Screenshots use generic fixture names only.
