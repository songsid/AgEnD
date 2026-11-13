# Owner grants by AD group and name search — M-3016 / #3743 item3

An owner can choose a person by name/login prefix or an AD security group in the existing grant dialog. New grants are capped at90days on both server and UI; old longer rows keep their recorded expiry, ID and revision. Group membership is checked afresh, using immutable GUIDs and the existing4/person32total physical read owner. Operational Hub permissions remain an AND gate; roles helpers stay unmounted.

The implementation and shared M-3014 boundary are in [the design note](../../design/hub-owner-group-grants.md). The shipped `hub` skill describes the controls and limits.

## R1 review correction

The action proof now tracks its latest clock observation and permanently refuses after rollback or expiry. Its separate data-only selection fence remains available after ordinary action expiry for a fresh catalog observation; clock rollback also permanently retires that selection. Six person/group controls reproduce the original clock finding. At clean `627992254`, seven focused suites pass132/132 and both native typechecks pass. Three isolated semantic reversals are caught and restored. Original pre-R1 checks below keep their original scope.

The picker uses the established phone/coarse-pointer `--tap` treatment for inputs and selects. At clean `b5253efbc`, a fresh full current matrix passes12cases/141checks/64PNGs, including44px input/select/button geometry. Product and tests are byte-identical to the checked627 head; the later commit only records failed geometry in the browser harness. The controlled0eb stylesheet gives a40px kind select and42px person input, fails the new geometry assertion, and cleans up. That one negative capture is separate from accepted counts. All original144PNGs/receipts remain unchanged; the accepted combined gallery is44cases/407checks/208PNGs. Eight fresh phone originals and their eight pre-R1 counterparts were visually compared, within that bounded scope. See `r1/` for receipts, checks, logs, reversals and visual paths.

Ridge withdrew the separate physical-close finding after checking locked ldapts9.2.0's Unbind/close chain. No directory finalizer or person-search test change is retained for it, and the private provisional stub results are excluded from acceptance. There is no new real-directory, native-platform or live-operation claim.

## Checks and provenance

| Evidence | Result and scope |
|---|---|
| Original feature fail-first | HTTP5 assertion failures/1 old-expiry positive; UI1 failure/2 older-mark controls. Historical modified test tree; original logs retained. |
| Slow-read fail-first |3 assertion failures,503 instead of200. Production HTTP/session/SQLite/subject evaluator, with an inert operational-permit seam advancing the clock6seconds. Restored controls include membership ending during that wait and a replaced directory method. |
| Final focused checks |281/281 in15files, `vitest run … --maxWorkers=2`, at clean `78874096d7fbd861f7742c76b8f3d80e0779b5c8`; includes both CI-reported inventory/wording fixtures. |
| Native types |Source and test native TypeScript checks both exit0 at that same head. Commands/exits are in `checks.json`; raw logs are gzip files under `logs/`. |
| Reversals |Final21 isolated executed reversals are assertion-red and exactly restored. Source hashes match the final committed product. Covers membership, proof/row/time/method fences,90day cap, immutable identity, shared physical pool, escaping/physical close/deadline, picker marks/single-flight/abort, unknown impact, slow-read recheck and catalog dedup. |
| Other reader controls |Earlier157/157 in11files: buttons, quota, attachments, publication, shell/module/SKEW and picker controls. This is historical pre-read-order execution, not a rerun claim on78874096d. Final15-file checks cover the changed read paths. |

Final proofs still expire within5seconds and the grant's expiry. Catalog selection keeps its original data-only row/session/policy fence across slow operational reads, obtains a fresh final subject observation when needed, and never revives the expired proof. Room-list proofs are acquired after operational reads. Durable dispatch/admit/tool/release derives the asker from the exact persisted message/current link; browser sign-out does not cancel an already accepted question.

Before review, alpha `5fc122feb` was merged cleanly at `d187710a9`. All grant product, harness and original evidence blobs are unchanged. The three overlapping files combine additive Hub/dashboard skill text and its test; incoming UI changes concern the existing join steps and E14, outside these grant-picker captures. Five focused suites pass96/96 on the merged head. `sync.json` binds both parents, unchanged paths and the exact command/result. The earlier checks and captures retain their original heads; no post-sync browser execution is claimed.

## Browser evidence

One serial Chromium, production HTTPS/cookies/CSRF/Hub UI and actual in-memory SQLite grant writes/revokes; directory and authenticated member transport are inert fixtures. No real account, AD, Fleet, pilot, native platform or model CLI. Phone captures are390×844 emulation; desktop1366×1000. EN/zh-TW and light/dark use the existing UI components and real installed CJK glyphs.

| Directory | Source and result |
|---|---|
| `browser-before/` |8cases/34checks/16PNGs at clean `a87be1c4d`. Retained base `34bd23bde` panel on the candidate server: an exact-login UI control, **not a baseline server execution**. |
| `browser-initial/` |12cases/116checks/64PNGs at clean `a87be1c4d`, before the server read-order correction. Original receipts and images unchanged. |
| `browser-current/` |12cases/116checks/64PNGs at clean `78874096d`: final server source. Repeated the full current matrix and four retained-asset controls. |

Total accepted gallery:32cases/266checks/144PNGs. Receipts bind Git head/tree, clean tracked source, input and served-asset digests and exact substitutions. Each current matrix covers empty/search/selected/allowed states, person/group90day writes, membership leave/rejoin and revoke checks. No horizontal overflow and no measured phone button below44px in these runs. `capture-comparison.json` records58 byte-identical final/initial PNGs; six changed originals were separately compared visually and were clear. The static check is bounded to12 initial originals and six final/initial pairs, not a whole-gallery visual verdict.

SKEW controls retain the old client (exact-login fallback), old group-search module, old dictionaries, or omit the new server feature mark. They cover these substitutions only, not an all-old-JS/CSS matrix. The earlier load-stopped partial run is excluded from accepted counts; its original receipt confirms cleanup. The final supplement paused once between legs at load10.19, resumed below10, and cleaned browser/server/rig/home.

Nonblocking inherited/presentation limits: dates follow the browser locale; saved groups show their verified DN label; group search reuses Add before final Allow; the group-change button has generic “Choose someone else” copy.

## Risk and rollback

The registered `s3-grant-subjects` migration adds default-person kind and display-label columns without rewriting personal identity bytes or existing expiry. Older binaries refuse the new schema: rollback requires the matching pre-upgrade database backup. No automatic rollback or live migration was performed here. AD group managers can change who may ask, as disclosed before granting; nested/primary groups are excluded. Unknown facts hold access without revoking the shared grant or becoming an authoritative removal in impact previews.

`manifest.json` is digest-first to avoid treating source digests as credentials. It covers the evidence files; the original receipts separately bind captured product/harness and served inputs.
