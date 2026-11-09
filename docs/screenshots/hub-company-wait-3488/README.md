> **Current scoped R1 receipt:** [b8e003e29 — mismatched-operation discovery](r1/README.md). The material below remains the historical962d4f6c4 acceptance.

# #3488 / M-2722 — a company join waiting on local confirmation

**摘要：** 新分頁等待的是 Fleet 本機的設定確認，當時 Hub 登入尚未開始。修正顯示下一步、帶到既有確認卡，並讓相同的空白狀態仍持續讀取；等候到期可再次檢查或返回。撤回完全使用 #3487 的共用確認卡。本次沒有實作三張卡合一的設計提案。

Review head: `962d4f6c4d7684526a605176d7e6a75d676fd1a3` (PR #3491). Plain merge includes landed #3487, `e2ce7ec6a61e18b93c917b3b73f05b217373059e`.

## Root cause and scope

A dashboard session without the D3 host-launch proof receives **202 / pending_confirmation** when it starts company joining. Local confirmation must finish before a company-join operation exists, so its status can legitimately remain `operation: null`. Previously the new `joinWait` page represented that as loading bars with no usable next step. Its polling effect depended on a changed view; repeated null results could prevent re-arming. The earlier host-launch acceptance applied immediately and missed this branch.

Reproduced using real Settings HTTP and Chrome on alpha.9 `923ccf98bb70be7ebbb6c8ae639a0a1b15e07dd8` and initial alpha tip `bddab17f9f149976413fa1c1d842383e83ea21e4`. The separate private operator screenshots were inspected locally, never copied here. The browser-chrome identity chip does **not** establish which AgEnD server confirmation the operator had; this is a reproduced product path, not a claim about their private session.

## What changed

- A waiting handoff is not a loading skeleton, including before its first slow read. It explains that local confirmation is required and supplies **Review local confirmation / 開啟本機確認** and an exit.
- The initiating tab retains the exact pending id and reveals that existing `.pending-card[data-pending]`. The new tab has no pending-id proof: it reveals the existing confirmation region, without choosing or applying another request. Missing mounted controls lead to Needs you.
- **One confirmation implementation:** the shared card owns Apply/TOTP/General guidance and Withdraw. The panel neither duplicates these controls nor retains a resend payload. A withdrawal with an unknown result stays pending; a positively withdrawn result says sign-in did not begin.
- The original pending deadline uses the server's remaining time, capped at five minutes. The new tab has a fixed five-minute local pre-operation wait. A status read never extends either. Timeout stops automatic company-status reads; Check again is read-only, and leaving does not claim cancellation. The shared confirmation store still follows its server-owned request.
- Status reads are single-flight, re-arm after unchanged null results, and retire on unmount/generation change. Only this exact handoff can redirect to its bridge.
- New words register with this component, so a retained older dictionary remains usable. Server authorization, confirmation deadlines and enrollment journals are unchanged.

## Browser evidence

All current matrix screenshots and real-HTTP receipts are under [current](current/receipt.json): **8 cases, 62 checks, 28 PNGs**. They cover desktop/phone × light/dark × EN/zh-TW: actual Start202, loaded wait, Review to the shared card, frame/overflow/tap checks, known exact withdrawal and no enrollment. The zh timeout leg advances **only the browser clock** and verifies that the server request is still pending; it does not simulate a server timeout or authorization decision.

| State | Desktop EN | Phone zh-TW |
|---|---|---|
| Local confirmation wait | [PNG](current/desk-light-en-waiting.png) | [PNG](current/phone-dark-zh-TW-waiting.png) |
| Existing shared card | [PNG](current/desk-light-en-review.png) | [PNG](current/phone-dark-zh-TW-review.png) |
| Known withdrawal | [PNG](current/desk-light-en-withdrawn.png) | [PNG](current/phone-dark-zh-TW-withdrawn.png) |
| Local wait ended, result unresolved | — | [PNG](current/phone-dark-zh-TW-timeout.png) |

Retained alpha.9 shell/dictionary/confirmation module assets: [receipt](retained-assets/receipt.json), **2 cases / 17 checks / 7 PNGs**. [Asset hashes](retained-assets/asset-manifest.json) pin the older copies. These are static asset substitutions only; HTTP API answers are not replaced. The current matrix uses the **actually landed #3487** card, not the superseded preview revision.

Fresh exact-code end-to-end rig: [receipt](queued-completion/receipt.json), desktop and phone. It waits through repeated null reads, proves no Hub enrollment before local confirmation, submits the real shared card's authenticator form, follows the actual bridge, signs in to the synthetic directory, and observes the **same operation saved/online**. The dummy authenticator was pre-enrolled only in scratch fixture storage, a disclosed setup boundary. No approval endpoint is stubbed. [Desktop held](queued-completion/E2E-desk-null-polls-held.png), [phone Hub sign-in](queued-completion/E2E-phone-approval-continued-to-hub.png), [phone online](queued-completion/E2E-phone-online.png).

Browser runs are pinned to `cef3a7468d10a567d966167635823597a40d9910`; the final review head differs by **one test-line placement only**. [Manifest](manifest.json) verifies every relevant production/module/smoke-script byte is identical and hashes all 44 PNGs. The final test places another request before the correct card, so choosing the first card is caught.

### Replay

In a checkout of the review head with dependencies and a private Playwright installation, run:

```bash
REPO="$PWD" OUT="/your/owned/output" \
PW_DIR="/your/private/playwright-prefix" CHROME="/your/chrome" \
FONTCONFIG_FILE="/etc/fonts/fonts.conf" MATRIX=full HP=54910 \
node --import tsx scripts/manual/smoke/smoke-hub-company-wait-3488.mts
```

Use a free loopback port and an owned output directory. The script creates scratch HOME and refusal-only CLI shims, blocks foreign browser origins, and closes its fixture/browser and removes scratch storage in `finally`. For the retained-asset leg use `MATRIX=quick`, a different free HP, and `ASSET_ROOT` containing the four older files from the asset manifest. No real account, directory, fleet, pilot, model request or native/Windows operation is used.

## Tests and negative controls

- Initial regression: **6/7 fail** before the fix. Shared-control follow-up: **1/8 fails** while the duplicate panel withdrawal still exists, then **8/8 pass** after removal.
- Final focused run: **185/185 across 8 files**, zero skips: join wait, join UI/settings/local, shared pending card, CSP, literal i18n and named-link copy boundary.
- Both production/test TypeScript checks pass. No timeout increase.
- [Eight compiling guard reversals](mutations.json) each fail an actual assertion: loaded skeleton, unchanged-null re-arm, visible timeout, stop at timeout, exact card, physical single-flight, positively known withdrawal, and exact handoff. Source restored and the clean focused set passed afterwards. An initial ordering mutant survived because the wrong card came later; the final test puts it first and catches it.

## Limits, cleanup and rollback

- These are synthetic browser/HTTP checks, not a Mac/native or real AD/account acceptance claim. Some lower existing phone form actions require ordinary scrolling. The shared card's redacted action-summary sentence remains English in zh-TW; it is existing server-generated copy, not a raw locale key introduced here.
- The first broader local run hit import/hook and unchanged backend HTTP 10s timeouts under load; a serial wider run still had one unchanged HTTP timeout. These are disclosed, not counted as passing acceptance. No timeout was raised. The earlier CI copy-boundary assertion was fixed in source rather than rerun. One SKEW invocation used an unsupported matrix name and ran zero cases; it is excluded, and the corrected `quick` run is the receipt above.
- Browser/fixture teardown completed. Independent checks found **zero live owned processes, remaining scratch roots or listening ports** for the final end-to-end rig (33 recorded PIDs), and for the earlier rigs (21 and 47 PIDs). No other resources were stopped.
- Rollback is this UI/test/smoke change's revert. No server state format, stored credential, identity binding or authorization rule changes.
