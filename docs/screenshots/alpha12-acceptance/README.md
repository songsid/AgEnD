# alpha.12 acceptance — Sentinel / M-2852

**Candidate: `22b1432edc179e8989e542c4d87928bed2b2f41a`. Baseline alpha.11: `636328df913c8a01081f3a35d1d14f408635977b`.**

Story issue: [#3599](https://github.com/songsid/AgEnD/issues/3599). **No P1/P2 found within the executed scope.** One non-blocking P3: [#3600](https://github.com/songsid/AgEnD/issues/3600).

The candidate product tree was unchanged. This branch adds evidence only. Real Chromium, FleetManager HTTP/SSE and the current UI ran in private user/network namespaces with only loopback enabled and fresh HOME/AGEND_HOME. No fleet start, real account, vendor request, live fleet, pilot, Windows operation, actual AI CLI or tunnel executable. The unchanged process guard was preloaded. Credentials and messages were synthetic; real lifecycle, probe and tunnel-process boundaries were inert.

| Story | Result | Actual checks and limits |
|---|---|---|
| A12-01 · #3563/#3562 單一登入碼欄 | PASS | Real browser/server: 6-digit TOTP and 8-character device code; automatic submission; same wrong-code result for an actual synthetic collision; no session/step/notice on collision; wrong-code and 429/pause controls. Browser clock explicitly paused: no request at 799 ms, TOTP at 800 ms, extending to eight cancels six, pasted six immediate. Focused core ownership/auth negatives also passed. |
| A12-02 · #3570 存取與安全、關閉公開連結 | PASS + P3 | Desktop/phone real overview, three cards, no current-device revoke button, named close confirmation, actual close route/manager state, remembered owner removed. Route negatives preserve gateway/guest/read/header-token exclusions and outside-owned link. **#3600:** success notice precedes badge removal by the next normal SSE tick (9,703/9,648 ms); access is revoked immediately. |
| A12-03 · #3573 建立 Agent 時選擇帳號 | PASS | Real browser → confirmation/replay → create HTTP validation → inert lifecycle callback. Selected `work` becomes `backend_options.claude-code.credential_profile`; no top-level credentialProfile remains. Signed-out choice disabled; unsupported CLI hides the field; changing CLI clears it. Expected confirmed-write handoff closes the wizard; no real Agent starts. |
| A12-04 · #3577 登入截止時間、需要重新連接 | PASS | Private synthetic files drive production Accounts view and Needs-you derivation/SSE. In-use `soon`/`ended` profiles show fixed local dates/times with keep-alive off; ended row says 需要重新連接. No keep-alive runner starts. Focused unused/dateless/other-CLI and actual-launched-profile controls pass. |
| A12-05 · #3574 管理員用語 | PASS | Focused locale guard plus actual zh-TW access/device/needs/account surfaces; desktop and phone screenshots inspected. |
| A12-06 · #3561 各模型每週用量 | PASS | Real UI with synthetic usage snapshot: per-model weekly (including 0%), both Claude profiles, compact third bar, no unused Codex model, no old capacity footnote; fresh and retained alpha.11 dialog/CSS combinations. No provider fetch. |
| A12-07 · #3564 寬鬆編號清單 | PASS | Production SSE messages → actual chat renderer: blank-separated numbered items remain one list; a real paragraph splits it, preserving start=4; nested unordered list retained. Desktop/phone composer and layout clear. Old chat panel/current thread compatibility passes. |
| A12-08 · #3581 喚醒套用儲存的 profile/model | PASS — inert launch | 19/19 lifecycle cases use real config/buildCommand and owned Node argv/environment recorder. Saved profile/model applied, supersession/lease/pause/native controls preserved. No actual backend or Windows spawn. |
| A12-09 · #3582 Codex receipt／pending forward | PASS — captured stream | Private tmux replay of captured real pane frames uses production judge/readiness: stranded → submitted in **317 ms**, confirmation true, **0 recovery Enters**. This proves the replayed stranded-wait mechanism, not all historical reporter latencies. Ten confirmation cases and 46 forwards cases preserve owner/deadline fences and delivered-only forwarding; hidden/missing remain indistinguishable. |
| A12-10 · #3593/#3594/#3596 Claude 2.1.322 | PASS — fixtures | Cold-resume retry/startup and file-card suites pass, including bounded escapes, exact menu/identity and near-miss/quoted negatives; native file-send controls also pass. #3596 is test-only. Connector cards are reconstructed fixtures from captured CLI chrome plus audited wording; no fresh claude.ai/email connector or real Windows claim. |
| A12-11 · #3592 Muse 1.4.15 | PASS — fixtures | 80/80 audited-layout cases: three-option held permissions, identity, post-turn tips/idle, draft near-misses, busy text, login/trust/resume/quota/background controls. No live Muse or vendor run; unobserved memory-write prompt remains outside the claim. |

## Evidence

- [Sign-in browser results](results/signin.json): 38/38; [chat/collision](results/signin-chat.json): 26/26.
- [Browser clock timing](results/signin-timing-paused.json): 10/10. The clock is paused before typing; exact boundary does not rely on wall-clock speed.
- [Accounts, access, Needs-you, chat](results/browser-stories-steps.json): 39/39.
- [Additional retained-asset checks](results/skew-stories.json): 34/34; old settings panel/new modules, new overview/old store, new create/old strings and old chat/new thread, each desktop + phone.
- [Closure settling](results/close-settle.json): 14/14; [weekly](results/weekly-complete.json): desktop/phone expanded + compact, two asset skews; no clipping, page errors or CSP failures.
- [Focused tests](results/focused-summary.json): initial 714 passed / 19 fixture failures; corrected sandbox wake run **19/19**, giving **733 passing cases across the 22 requested files**. This is a combined result, not a claim that the initial whole run was green.
- [Private tmux replay](results/receipt-replay-private.json), [source hashes](PRODUCTION_SHA256SUMS), [final cleanup](cleanup/final.json), [scanner](results/gitleaks.json).
- [PNG index](PNG-INDEX.md), 65 PNGs: desktop 1366×900 / phone 390×844, zh-TW, plus baseline/SKEW. 22 primary images and four targeted follow-ups were visually reviewed; settled close state is Closed with no green badge/countdown/close button. Headless phone geometry, not physical touch/keyboard acceptance.

## Disclosed rig corrections

All earlier outputs are retained locally under `.artifacts/a12-acceptance/`; cleanup receipts are included here. These were investigated fixture assumptions, with no product edits or blind product retries:

1. The initial weekly driver lacked a baseline asset exported from the correct `src/ui/shared/` path; fresh checks passed, then the missing-file error stopped SKEW. Correct asset export completed all legs.
2. `unshare -Urn` maps the rig to UID 0. Its initially clean environment omitted `IS_SANDBOX`, so the production Claude root guard returned before constructing the daemon and all 19 wake cases failed at pause. `IS_SANDBOX=1` in this genuinely isolated inert-recorder run fixes the mismatch.
3. The original committed receipt driver used scratch prefix `r3578-`, which the unchanged process guard refused. The owned derivative changes only that prefix to the allowed private `agend-replay-3578-`; no tmux operation occurred on the blocked attempt.
4. Initial browser create checks incorrectly awaited wizard step 3 after a 202 confirmed-write handoff. The final driver instead checks the actual lifecycle callback and translated profile. Both creates reached the inert handler; no product defect established.
5. The timing driver initially registered a response listener too late, then allowed the browser clock to run in real time between a 799 ms assertion and the next input. The final driver registers the listener first and explicitly pauses the browser clock, pinning 799/800 and extension cancellation deterministically.

## Cleanup / reproduction boundary

All 17 owned namespace runs ended with zero tracked live descendants; all owned temporary roots and 17 scratch HOME directories removed. Final `/proc` argument scan found no process retaining an owned temp path. The private tmux server was stopped by its exact socket; no host/default tmux was touched. Synthetic credential homes and browsers/listeners are gone. Evidence is retained; product files were unchanged.

Drivers are snapshots of the actual owned acceptance files. The original execution wrapper lives at `.artifacts/a12-acceptance/run-rig.py` and expects this workspace's worktree/browser/font paths. It is not a host installation script. Commands were `python3 .artifacts/a12-acceptance/run-rig.py <case> <candidate script or absolute owned driver> [KEY=value]`; accepted cases are named in `cleanup/`. Fresh UI runs use the committed candidate `scripts/manual/smoke/` drivers; owned extensions are in `drivers/`. No acceptance result authorizes a live-account or native run.
