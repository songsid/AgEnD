# M-3015: real pause/resume of Hub sharing

The old Stop sharing path freezes a publication revision. Re-publication requires new grants; renaming that action cannot preserve an allow list. This change adds an independent owner pause and epoch on the Hub, with explicit resume and the existing permanent Stop sharing kept separate.

Person/group grants retain their exact IDs, revisions, permissions and absolute expiry dates. Expiry keeps running while paused, including retained grants longer than the new-write 90-day maximum. Resume does not revive expired/revoked grants, old publication revisions or group/policy holds. Paused agents disappear from new-chat choices; an authorized existing room stays readable with a paused banner and disabled composer. A stale-tab question receives `sharing-paused`, rather than closing the chat. Pre-pause Hub-consumed answer-release leases are retired immediately, and Hub-side asynchronous operation proofs bind the pause epoch even on legacy-policy fleets. A pre-Pause authorization already in transit may still start its one first input per issued operation within the existing ≤5-second lease. Once the member observes the committed authorization-version/reconnect fence, old capabilities stay invalid after Resume. Already-running work is not retroactively killed; no new authorization is issued while paused.

## Source and tests

- Design: [hub-resumable-sharing.md](../../design/hub-resumable-sharing.md).
- Browser product/harness capture: clean `3a90921c2`. Before capture: clean `56a3e2665` (only held-Resume tests added).
- Plain merge `c68d667e9` has parents `56a3e2665` and alpha `ead8d4a80` (#3794). Those 28 incoming files are disjoint from this feature. A second clean plain merge `9d94c8f4` has parents `c68d667e9` and alpha bcd7a4853 (#3790); its18 incoming files are also disjoint. All captured Hub/UI/auth/skill/harness input bytes remain identical; see `source-parity.json`.
- `final-focused.log`: **234/234 across 12 suites**, including new production HTTP/session/SQLite, mounted UI, migration, group grants, vocabulary, history, permanent-stop controls and policy-impact inventory.
- `baseline.json` / `current-tests-baseline.log`: the **current 14 server tests fail semantically** against baseline backend bytes at `bc22d3b8`; no transform/import failure. The new unused `sharing.ts` is unreachable under the baseline composer. Exact source restored, then **23/23** new server/UI/migration tests pass in `restored.log`.
- Both native source/test typechecks pass. Pre-sync receipts and fresh sync checks are retained; no native-platform execution claim.
- `mutations/`: **10 isolated semantic reversals caught**, restoring exact bytes after each: owner, persisted pause, operational resume gate, retired leases, reconnect preservation, epoch/ABA, exact request epoch, server/client feature marks, disabled paused composer, stale-question room state. Each reversal first passes the native source compiler, then fails an assertion in its intended production path. The runner paused once at load>10 before S7, restored source, and resumed only the remaining four when load dropped.
- New schema `s3-sharing-pause` preserves existing data. The old registry refuses the newer schema. Rollback requires the matching pre-upgrade Hub database backup.

## Browser and PNGs

One serial Chromium, an owned HTTPS port-0 server, real Hub cookies/CSRF/SQLite and production assets. The directory, people, GUID memberships and member publication are inert fixtures. Actual UI pause/resume and permanent-stop requests write the fixture database. No live Fleet, real account, AD, model, Mac pilot or native-system operation.

- `browser-current/receipt.json`: **12 cases, 195 checks, 52 original PNGs**. EN/zh-TW × desktop/phone × light/dark, plus old client, old word dictionaries, retained app/owner CSS and absent server feature mark.
- `browser-before/receipt.json`: **8 cases, 43 checks, 8 original PNGs**. A retained baseline panel on the candidate server; this is a before-UI control, not baseline-server execution.
- Each normal current case captures shared → paused → existing asker paused → resumed → permanently stopped. It verifies exact person/group grant bytes, catalog exclusion/restoration, no Resume after Stop and no horizontal overflow. All measured phone owner actions are at least 44×44, including retained shell CSS through the feature stylesheet.
- `visual-review.json`: bounded static review of 12 current and two before originals. No clipping/overlap blocker; no whole-gallery or real-device claim. Desktop Stop sharing lies below some captured viewports; inspected phone originals show its full distinction. The Info rail still describes the grant's nominal “Ask, and read” capabilities; the paused banner separately states current availability. English month names in zh-TW grant dates predate this change.
- An additional diagnostic single case passed before the main campaign; it is not added to the totals. Every owned browser/context/socket/temp HOME was cleaned. The browser slot was released to dev-claude.

Useful zh-TW originals: [desktop paused](browser-current/current-desk-light-zh-TW-paused.png), [desktop dark](browser-current/current-desk-dark-zh-TW-paused.png), [phone paused](browser-current/current-phone-light-zh-TW-paused.png), [phone dark](browser-current/current-phone-dark-zh-TW-paused.png), [asker paused](browser-current/current-phone-dark-zh-TW-asker-paused.png), [permanent stop](browser-current/current-phone-light-zh-TW-stopped.png).

## Limits and authority

Pause/resume is offered only with matching server/client `sharing-pause-v1` capability. Retained clients keep permanent Stop sharing; old renderers may lack the new pause presentation but cannot bypass server checks. Member snapshot and authorization wire schemas stay unchanged; `paused` and `sharingEpoch` are Hub browser projections. The Fleet Share switch still means local publication; the card points to My shared agents for a resumable pause. The Hub skill is updated. No roles helpers are activated and no M-3014 guest rooms are implemented.

## CI-only fixture repair

Initial-head CI43378316649 found missing changelog front matter (also the shard3 repository-fragment test), the old skill assertion that pause/resume is not built, and the old exact group-route feature lists. The repair adds matching `Added` front matter/list syntax, pins pause/resume in the built Sharing section while keeping roles/guest-room/2FA unavailable, and adds the always-composed sharing marker to exact feature lists while retaining all group-route404/admin/CSRF negatives.

`ci-repair/`:51/51 across the two changed suites and the new sharing server/UI controls;432fragments pass the real parser; native test types pass. Runtime/source, harness and all60PNGs remain byte-identical to the reviewed parent. All original107manifest paths were verified before adding this receipt. No browser rerun or old-head hosted-green carry is claimed. The replacement head requires its own CI and reviewer verdict.


## R2: accepted capability window and stale-history correction

The leader accepted the precise bounded window on 2026-11-13 and explicitly rejected a new acknowledged member-fence protocol; this decision is also in the PR description and design. The original broad pre-pause capability-retirement claim is superseded: SQL deletion immediately fences Hub-consumed releases, but locally consumed results already in transit have the existing ≤5-second exception. The sharing writer now advances the global authorization version in its SQLite transaction and calls the existing member reconnect refresh only after commit. Members that observe the fence permanently reject old capabilities, including Pause→Resume. This briefly reconnects all current member links; it does not revoke credentials or restart the listener.

The writer rechecks the operational Resume proof in the transport writer's final pre-publication callback, after its audit. The outer permit then accepts only the exact resulting transport image plus its exact exposure/session image, rather than mistaking its own version advance for a stale proof. Missing refresh composition offers no sharing feature and refuses the action. Grant rows and absolute expiries remain unchanged.

The real SQLite admission, member journal, `Client.authorize` and representative `beforeInput` control holds only the begin result after actual Hub lease issuance. It pins the documented in-transit exception, single input intent, exact expiry, observed fence/ABA refusal and fresh post-Resume positive. The RPC transport, authentication link and local input sink are inert: these counters are not real Fleet input or an end-to-end network Pause test. Existing real TLS/WSS authorization-refresh tests are run separately, and the server factory's callback wiring is independently pinned.

A second fail-first control holds a published room history read, receives a newer `sharing-paused` send refusal, lets the immediate retry fire while history is in flight, and then resolves the old response. Availability remains paused; after that read settles, a new read can show Resume. History entries remain available. This fixes both the old response overwrite and the lost immediate refresh.

`review-r2/browser/`: eight current-only cases,143 checks,40 fresh PNGs at clean capture `d37b921bf60dc1e05b09167ae07b1bfa50e4a3a6`. EN/zh-TW, desktop/phone, light/dark, all five owner/asker stages. Revised wording explains the in-transit window without an instant-stop promise. Feature sources/harness/helper are digest-bound by the receipt; later changes are tests/evidence only. The original20cases/60PNGs stay unchanged and historical; there is no new retained-asset/full-campaign claim. `visual-review.json` is a bounded8-original static PASS; remaining32frames were not visually reviewed. Owned Chromium, contexts, HTTPS sockets and temporary HOME are cleaned, and the browser slot was released.

R2 checks:97/97 in seven focused suites, then33/33 changed contracts after the additional no-new-begin assertion (overlap, not130 unique tests);1 selected real factory wiring control with118 cases deselected. Six isolated reversals compile with the native source compiler and fail semantically, with exact source restoration: version, refresh, final post-audit Resume proof, old history, expiry and feature admission. Both native type configurations pass. These are scoped checks, not a full-suite or new hosted-CI verdict.
