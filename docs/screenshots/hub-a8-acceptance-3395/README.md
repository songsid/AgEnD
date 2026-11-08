# Hub alpha.8 acceptance — #3395 / M-2655

中文摘要：在固定 alpha 原始碼上，使用隔離 Hub／member、真實 HTTPS/WSS/瀏覽器及假的 TLS AD 來源，實測部門權限、歡迎頁、快速配對、擁有者授權、回答、撤銷及暫停／恢復。沒有真實 AD、帳號、pilot、live fleet 或 Windows 操作。發現 P2 #3402（首次頁面讀取自己撞上並行限制）、P2 #3404（過期代碼失敗後仍殘留等待確認提示）及 P3 #3403（本機確認尚未完成就顯示完成勾）。這是驗收證據分支，不是產品修改或全面 PASS 聲明。

Frozen build: `f61e3608cdf888396474a99d1c76f766c8bf314f`; S88 #3397 `614fb69f` + S90 #3401 `f61e3608`. Source package.json `1.22.0` (not a published alpha package version). Node22.22.2, Chromium156.0.8078.4. Same product bytes for all legs. See receipts for exact timestamps and browser build.

## Boundary

- Actual sealed Hub initializer/factory, SQLite/audit, HTTPS/WSS, production AD driver against an owned synthetic TLS/BER peer. Synthetic immutable users/groups, verified TLS and critical AD extended-DN control; dummy passwords only. This is not a real AD certification.
- Actual member factory, local consent, exposure snapshots, journal/admission, representative, leases, release and pinned transport. Only the input handoff/model reply are simulated callbacks. No daemon IPC/native CLI/model/vendor API.
- The scratch member switch starts enabled; turning membership on is setup, not claimed browser acceptance. Public browser sign-in, Settings Apply, both fingerprint confirmations, publication, grant, policy preview/save, revoke and Resume. No policy, grant, approval, credential or provenance rows are seeded. Initial sealed configuration/designated admin and directory source facts are setup inputs. Host bootstrap code uses the same owned `/auth/issue-code` path as the upstream copyable rig; raw token never authorizes Hub pairing itself.
- Browser traffic restricted to the rig's Hub and fleet origins. Private scratch HOME and inert CLI shims. No container, host tmux, OS settings or host networking changes. Browser processes run headless with `--no-sandbox` in this owned mock rig; this is no browser-sandbox or malicious-content security acceptance.
- General rule: group capability does not create an owner grant. Explicit manual admin approval is independently bound and gives no welcome capability.

## Results (core path; detailed subcases/limits below)

| Story | Actual UI path / steps | Result / interaction count after sign-in | Evidence |
|---|---|---|---|
| A8-01 | Administration → Group permissions; resolve Owners/full and DeptA/ask-only; inspect unsaved impact; save; reload | ✅ Saved only after preview confirmation; 7 core clicks including two capability toggles | A8-01-* |
| A8-02 | Fleet Hub Share switch → Apply → offered owner grant link → allow asker → Open chats/pick/send → mock answer | ✅ Full consent/admission/journal/lease/release path; 6 core clicks excluding asker sign-in | A8-02-owner-grant / answered |
| A8-03 | Other-department sign-in; open stale room URL | ✅ No protected answer or representative input; navigation only after sign-in | A8-03-* |
| A8-04 | No-matching-group sign-in, desktop/phone × EN/zh × light/dark | ✅ Both actions unavailable with contact-admin explanation | run-stage3 A8-04-* |
| A8-05 | Ask-only without grant; open agent picker. Granted asker uses the actual room | ⚠️ No ungranted agent disclosure; empty-state guidance intermittently omitted by #3402; Open chats is one click | A8-05-* |
| A8-06 | Full capability before pairing, no grants; later inspect slot limit | ⚠️ Correct capability split and quota refusal; empty guidance has #3402 | A8-06-* / A8-14-stale-tab-quota |
| A8-07 | Make membership omitted/unknown; sign in; Retry after source restoration | ✅ Both actions held; recovery does not Resume a never-suspended resource; 1 Retry per case | A8-07-* (8-case matrix) |
| A8-08 | Hub Connect → local Settings Connect/Apply → compare exact fingerprints → local confirm/Apply → Hub match | ✅ Pinned/Online, no admin wait; separate explicit local publish; 6 core clicks. 8-case pending/connected + phone detail captures | A8-08-* / A8-09-pending-* |
| A8-09 | Unknown during pending, mismatch/Stop, natural expiry and reuse of expired code | ⚠️ Core refusals/no credential; #3403 premature milestone. Actual ten-minute expiry/410, local held-expired and reused-code refusal passed; #3404 stale confirmation recovery text | A8-09-* |
| A8-10 | Other owner/admin notices; exact owner Revoke; independent manual control rechecks Online/active | ⚠️ Active-recipient notice and one-click exact revoke passed; offline catch-up not run. Separate manual credential kept. A transport authorization refresh briefly reconnects links; do not claim uninterrupted sockets | A8-10-* |
| A8-11 | Hold mock reply; owner row menu → Revoke → confirm; report held answer; withdraw locally | ✅ Held answer refused and absent; 4 send/revoke clicks + 1 withdrawal. Read-only history is not claimed erased from existing browser memory | A8-11-* / heldAnswerResult |
| A8-12 | Complete nonmatching membership → send refused; restore group → still refused; admin exact Resume → answer | ⚠️ Enforcement and explicit Resume passed; 4 core send/Resume clicks. Asker-facing failure wording is generic and affected by #3402; do not label the PNG a clear pause explanation | A8-12-* |
| A8-13 | Preview/save policy Off; verify group pauses/manual retained; preview/save On | ✅ No legacy allow-all; resources still need Resume; 4 core clicks | A8-13-* |
| A8-14 | Stale pairing tab submits beyond quota; retained old client/CSS phone zh dark | ✅ Current server refuses stale action, no code; old client grants no actions. Quota view in stale tab needs refresh; not a claim of instant projection updates | A8-14-* |
| A8-15 | Eligible no-group owner: exact owner/local/admin confirmations during unknown membership; later manual above max1; ineligible owner offer refused | ⚠️ Manual pin/Online without welcome grants; person-deny creation and unknown ordinary eligibility not run. Second explicit manual pin above automatic quota, then “2 of 1” blocks self-service. 9 core confirmation/create clicks per successful manual path | A8-15-* |

Counts describe the replayed core interaction path after sign-in, not every login, screenshot, reload, failed fixture attempt or matrix repeat. `clicks` in raw receipts records selected named interactions only; the complete browser calls are in the recipes. No terminal or General detour was needed for the completed UI paths. Hub and fleet-local fingerprint proofs remain separate authorities.

## Findings

- **P2 #3402:** one normal page starts five eligibility checks against a four-per-person cap. Original story run plus three clean sequential single-page controls: all three catalog requests 429 / Retry-After10; transparent no-delay wrapper records inflight4,total4 at rejection. Not an LDAP outage. Original multi-tab pressure is disclosed, not used as the isolated proof.
- **P3 #3403:** local confirmation step marked done before its separate fingerprint consent. Correct refusals remain intact.
- **P2 #3404:** actual ten-minute expiry refused; a fresh binding reused the expired code and saved no credential, but the known failed proposal left “Waiting for your confirmation”. The PNG shows the failure banner; the below-viewport stale line is proved by the contemporaneous settled DOM text/log, not by that PNG alone.
- **No P1 authority leak observed in these legs.** This is a bounded mock integration/UX result, not a live-directory security certification.

## Limitations and calibration failures retained

- Explicit per-person-deny creation has **no editor UI** at this build (the editor renders existing denies). That creation/negative and unknown *ordinary eligibility* are NOT RUN browser subcases. Ineligible owner rejection was run. No hidden API or DB write substituted for a missing UI.
- Offline notice catch-up and a standalone administrator-replaced offer were not independently exercised; active other-owner/admin notice, exact revoke, Stop/mismatch, unknown pending and natural expiry were. No claim that every recipient was notified immediately offline.
- Original `run-base` failed before stories because Chromium's singleton socket path exceeded its limit. Fixed only the owned TMPDIR length.
- `run-base2` used `.p` instead of fixture `.page`. `run-stage3` used a generic login-code session lacking the local host confirmation proof. The actual path was rerun using the upstream owned host bootstrap/sign-in path; no product fence was relaxed.
- One `locator.check` expected an immediate switch change, but Share intentionally awaits Settings confirmation. Continuation used the existing pending Apply. One reloaded `grant=1` URL reopened its Allow dialog; cancelled it before the owner row menu.
- A strict locator refused to choose between two admin approval buttons; corrected by binding the UI row to its exact fingerprint. No wrong row was approved.
- A slowed manual leg used the inherited 250ms fixture polling and exhausted the real 60/min claim budget (read-only diagnostic recorded60), correctly holding unknown. Abandoned, not auto-retried. A NEW exact-fingerprint attempt with production 5s cadence passed. This is not evidence of a default-production poll bug.
- Some initial captures preceded settled reads. Catch/diagnostic images are not accepted state evidence; all raw failures remain in logs. A later paused/revoked room may show generic authorization/busy state; no inference of disclosure from blank loading UI.
- The full matrices use the production UI and a host font directory for CJK; early missing-glyph rig captures are not product i18n failures. Core fingerprints/Connected below the phone viewport have separate scrolled detail PNGs; no CSS was changed.
- Scripts under recipe are the frozen private acceptance driver plus its chronological command segments. They are evidence, not a newly supported product API or general test runner.

## Evidence index

See [all PNGs](INDEX.md), raw [receipts](receipts/) and chronological [recipe segments](recipe/). A screenshot is a particular captured frame, not proof that every later frame is identical.

## Natural expiry and cleanup

Natural deadline2026-11-08 02:24:01.778UTC, start02:14:01.801UTC. No clock injection. Hub410/explicit start-again, local held-expired, then expired-code reuse leaves a fresh member unpaired. The driver's expected inline-error selector timed out because Settings presented its failure in the pending-change banner; the settled frame/text is retained and filed as3404, not called a clean UX pass.

Cleanup: all close calls completed02:25:54UTC. Node+esbuild+owned Chromium PIDs absent; Hub member/fleet web/preview/LDAPS ports bindable. Web43955 had TCP TIME_WAIT: ss showed no listener and SO_REUSEADDR bind succeeded. Both active roots absent; earlier failed-run owned scratch and the dedicated temp root removed. See receipts/cleanup-final.json. Original unrelated tracked edits website/public/tips-en.html and tips-zh.html remain untouched. No product change, merge, deployment or rollout; rollback is not applicable to this evidence-only branch.

To replay, copy the stage4 driver into `scripts/manual/hub-quick-pairing/` in an OWN frozen checkout, restore its sibling smoke fixture/dependencies, choose private ART/OUT/HOME and a SHORT owned TMPDIR, and set REPO/PW_DIR/CHROME/FONTCONFIG_FILE. Its initial comment retains the upstream empty-inventory description; the executed `attachMember` body and receipt boundary are authoritative: this driver constructs the full member factory. It waits for chronological command segments via ART/command.mjs and stops on ART/stop. Do not run the evidence copies in-place or reuse an active rig's roots.
