# M-3015: real pause/resume of Hub sharing

The old Stop sharing path freezes a publication revision. Re-publication requires new grants; renaming that action cannot preserve an allow list. This change adds an independent owner pause and epoch on the Hub, with explicit resume and the existing permanent Stop sharing kept separate.

Person/group grants retain their exact IDs, revisions, permissions and absolute expiry dates. Expiry keeps running while paused, including retained grants longer than the new-write 90-day maximum. Resume does not revive expired/revoked grants, old publication revisions or group/policy holds. Paused agents disappear from new-chat choices; an authorized existing room stays readable with a paused banner and disabled composer. A stale-tab question receives `sharing-paused`, rather than closing the chat. Pre-pause release leases are retired, and asynchronous operation proofs bind the pause epoch even on legacy-policy fleets. Already-running local work is not retroactively killed; subsequent Hub authorization is still required.

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
