# alpha.11 hands-on acceptance — #3565

**候選：`636328df913c8a01081f3a35d1d14f408635977b`。已執行範圍內未發現 P1/P2。**

Sentinel / M-2819. This is an evidence-only branch; product code was not changed. The published npm package and real Windows installation were not executed. PASS below means the expressly stated browser/protocol/mock scope passed, not that a mocked vendor or Windows operation ran.

## Environment and method

- Exact frozen alpha source, built successfully with `npm run build`; tracked product diff empty. [Source and campaign manifest](manifest.json).
- Each campaign ran with an empty inherited environment, owned scratch HOME/AGEND_HOME/TMPDIR, private user/network namespace and only loopback enabled. The unchanged native-process guard was preloaded. No real account, vendor API, live fleet, pilot, host network/OS setting, real CLI installation/update or real fleet restart.
- Real Chromium, desktop 1366×900 light zh-TW and phone 390×844 dark zh-TW for the main journeys; usage also uses a narrower340px phone. Additional EN/retained-asset cells are identified in each summary. Phone viewports do not prove native iOS/Android gestures.
- Hub connection/admin/lifecycle used the production AD driver against owned synthetic TLS/BER directory peers and actual sealed Hub/Fleet web routes. The independent chat-reload rig uses a synthetic directory and inert protocol-member answer.
- Windows used an explicit fake public-protocol Runtime: actual signed command enrollment exchange, server fingerprint proof, encrypted credential handoff and authenticated WS. The bundle was inert, inventory/install/update callbacks synthetic, and the generated PowerShell command was **never executed**. No actual Windows signature/download/autostart/installer/registry acceptance is claimed.

## Story table

| ID | Story and actual actions | Result and evidence |
|---|---|---|
| A11-01 | 遠端具名管理員：未設定／未開啟要求驗證器時確認；開啟後另一人的碼遭拒、自己的碼套用；App 設定、更換、關閉及通知。 | **PASS** — actual session/Settings/TOTP; fake Discord posts and deletion lifecycle. [Current](auth-verified/summary.json), [retained alpha.10 shell](auth-retained-confirm/summary.json). |
| A11-02 | 尚未登入的新瀏覽器 → 驗證器登入；錯碼回饋、正確碼進入儀表板；web-only 不顯示姓名欄。 | **PASS** — [desktop](signin/desk-light-zh-TW-2-wrong-code.png), [phone](signin/phone-dark-zh-TW-1-authenticator.png), [scope](signin/summary.json). Named/ambiguous/demoted-admin and one-use-code controls: supplemental route tests. |
| A11-03 | 擁有者／另一部一般管理員裝置查看撤銷權限及單一裝置清單；後端拒絕非擁有者；擁有者確認後 epoch 前進且本機保持授權；read/guest 無法讀取帳號資料。 | **PASS** — [desktop](roles-final-verified/desk-light-zh-TW-devices.png), [phone refusal](roles-final-verified/phone-dark-zh-TW-admin-refused.png), [checks](roles-final-verified/summary.json). Other device/read/guest sessions are fixture setup through the real store, not additional browser login stories. |
| A11-04 | Runtime → 產生一鍵指令 → 比較伺服器指紋 → 加密一次性 token 入列 → mock Windows 電腦上線，無額外管理員核准。 | **PASS, protocol scope** — [masked command](runtime-final/desk-light-zh-TW-one-command-masked.png), [receipt](runtime-final/summary.json). Actual Windows bootstrap/OS installation **NOT RUN**. Token expiry/reuse controls: supplemental enrollment tests. |
| A11-05 | 帳號卡顯示完整長 email，手機換行後仍可閱讀；帳號狀態與操作保持可見。 | **PASS** — identity parsed from synthetic Claude auth-status JSON. [desktop](roles-final-verified/desk-light-zh-TW-full-email.png), [phone](roles-final-verified/phone-dark-zh-TW-full-email.png). |
| A11-06 | 主機安裝 AI CLI：按安裝、要求目前管理員的碼；錯碼不派送，正確碼才派送一次；新舊 shared assets。 | **PASS, launch stub** — [desktop](host-install/after-desk-light-zh-TW-code.png), [phone wrong code](host-install/after-phone-dark-zh-TW-wrong.png), [8 cases](host-install/summary.json). No actual installer. |
| A11-07 | mock Windows 安裝 OpenCode、Antigravity；電腦擁有者開關關閉時停用；開啟後成功回報；一次拒絕不改變 inventory。 | **PASS, fake Windows** — [phone confirmation](runtime-final/phone-dark-zh-TW-opencode-install-confirm.png), [failure](runtime-final/desk-light-zh-TW-install-failed.png), [scope](runtime-final/summary.json). |
| A11-08 | Accounts 主機 Update 及 Windows Update：目標版本、派送、進度、完成；主機與遠端各有失敗控制。 | **PASS, updater callbacks mocked** — [host](host-update-final/summary.json), [host failure](updater-failure-settled/summary.json), [Runtime](runtime-final/summary.json). Settings confirmation and CLI job outcome are distinct. |
| A11-09 | Windows OpenCode 仍去稽核版本；Antigravity 明示廠商最新版尚未稽核，請求帶最新版本同意欄位。 | **PASS** — [phone latest warning](runtime-final/phone-dark-zh-TW-agy-latest-update-confirm.png), [host latest](host-update-final/phone-dark-zh-TW-antigravity-available.png). Missing/incorrect old-client acknowledgement is refused in supplemental real-route tests. |
| A11-10 | Chat 選取段落 →「引用」→ 編輯框 → 送出；選取／取消／原稿與 retained panel/CSS 控制。 | **PASS** — [desktop composer](quotes/desk-light-zh-TW-4-composer.png), [phone sent](quotes/phone-dark-zh-TW-5-sent.png), [scope](quotes/summary.json). DOM Range selection, not native phone long-press. |
| A11-11 | Web Update：banner、取消／確認、下載進度、無網路失敗、完整紀錄、reload 提示、進階卡與 chat /update。 | **PASS, launch stub** — [summary](web-update/summary.json). Bounded npm configuration, registry failure classification and restart-env cleanup: focused tests; no real npm/update process run. |
| A11-12 | 子 Agent 執行中跨越主回合 yield；完成後15秒退出；待確認120秒退出；重新開啟不復活；唯讀／訪客／Hub 不擴權。 | **PASS** — saved mock-API records, production reader, fixed clock. [desktop running](subagents/desk-light-zh-TW-running.png), [phone completed](subagents/phone-dark-zh-TW-completed.png), [retirement/SKEW](subagents/summary.json). Access negatives in focused tests. |
| A11-13 | 用量卡在保留資料與空資料來源時顯示單行「更新中…」，完成後回到更新時間；舊 CSS/字串保留。 | **PASS, synthetic usage** — [retained data](usage/summary.json), [empty source](usage-empty/summary.json). No vendor usage read. |
| A11-14 | 單一 Hub 連線卡：公司登入、Connected、明確選擇分享 Agent、暫停／重新整理／恢復，保留選擇與 pin。 | **PASS** — actual Hub/Fleet/LDAPS path. [desktop connected](hub/desk-light-zh-TW-connected.png), [phone paused](hub/phone-dark-zh-TW-paused-reloaded.png), [27 checks](hub/summary.json). No Agent started or question sent in this campaign. |
| A11-15 | Hub Administration 的群組／人員入口、公司開關、個人邀請及進階手動 offer；This Hub Stop 取消／實際停止／Run。 | **PASS** — [admin](hub-admin/summary.json), [Stop desktop](hub-lifecycle/desk-light-zh-TW-stop-confirm.png), [phone](hub-lifecycle/phone-dark-zh-TW-stop-confirm.png), [actual listener](hub-lifecycle/summary.json). Web-only host rig; valid Hub sessions remain eligible to resume, explicit logout stays ended. |
| A11-16 | Settings/Chat 重新整理模型：busy、失敗／重試、選擇 backend/model/effort 的取消；同 backend 選 Opus 寫入 YAML，正常狀態更新後 UI 一致。 | **PASS, catalog/IPC mocked** — actual disk save. [desktop](models-apply-final/desk-light-zh-TW-chat-chosen-model.png), [phone](models-apply-final/phone-dark-zh-TW-chat-chosen-model.png), [scope](models-apply-final/summary.json). No real CLI/model switch or cross-backend restart. |
| A11-17 | ClassicBot 產生的 MCP／CLI 指令包含 matched worker+correlation 的結果回覆規則、原請求人提及、無關 peer 訊息保持安靜。 | **PASS, instruction-generation scope** — [focused tests](boundaries/summary.json). No live ClassicBot/model interpretation or vendor round-trip is claimed. |
| A11-18 | 具名 Codex work 帳號：既有 sign-in 確認、device-code 顯示、模擬完成；CLI launch spec 綁定 CODEX_HOME；舊模組相容。 | **PASS, auth/terminal mocked** — [desktop](named-signin/desk-zh-TW-current-codex-running.png), [phone](named-signin/phone-zh-TW-current-codex-confirm.png), [scope](named-signin/summary.json). No actual OAuth. |
| A11-19 | 具名 Kiro work 帳號：既有 sign-in 確認及 terminal、模擬完成，launch spec 綁定 XDG_DATA_HOME；舊模組相容。 | **PASS, auth/terminal mocked** — [desktop](named-signin/desk-zh-TW-current-kiro-cli-running.png), [phone](named-signin/phone-zh-TW-current-kiro-cli-confirm.png), [scope](named-signin/summary.json). No real Kiro TUI/provider request. |
| A11-20 | 回歸抽查：Chat 實際問題／mock member 答覆、10秒內重載／重開200；真正容量429有 Retry-After 並自動恢復；Settings/確認/用量/Needs-you 相關表面。 | **PASS within sampled paths** — [real HTTP/SQLite chat](chat-reload-zh/summary.json). Synthetic directory/member answer; no live model delivery. This is a sample, not a full alpha.10 replay. |

## Findings and limits

**No confirmed P1/P2 in the executed scope; no product-finding issue was opened.**

The following are intentionally outside the claim: real Windows install/update/autostart/signatures; real OAuth/AI account or model execution; native phone selection; live ClassicBot interpretation; physical npm updater latency under an actual external network outage. Mock/UI checks never stand in for these. No new product controls or authority changes were made.

Fixture corrections were retained privately as diagnostic runs, not counted as product FAILs: an unpackaged TypeScript runtime service correctly offered ZIP fallback until an inert asset seam was supplied; an initially malformed mock Runtime inventory was rejected; background auth/compatibility discovery was blocked by the native guard and then explicitly injected/reduced out of scope; an invalid synthetic account-state enum and a missing fixture status tick were corrected. A remote web-only Hub helper without its needed host authority was refused; retained-asset confirmation was exercised instead through the properly signed-in named-admin journey. An old shell's folded Advanced command is acknowledged, not asserted absent.

Visual review sampled desktop/phone warning, completion, failure, email, model, Hub, quote and subagent states. Final corrected samples have no established overflow, clipped email or mismatched model label. Enrollment/invitation codes are masked; TOTP setup QR/key screenshots and raw session/auth logs are omitted.

## Reproduction and cleanup

`run-rig.py` executes the candidate's public smoke entry points or owned derivatives under `unshare -Urn`, a scratch HOME and preloaded `tests/support/process-guard.cjs`. [manifest.json](manifest.json) records candidate tree, product hashes, final harness hashes and each scope; campaign summaries name the command entry point. Relevant committed starting points include `scripts/manual/smoke-fixture`, `scripts/manual/subagent-row/async-accept.mts`, `scripts/manual/hub-connection-card/accept.mts`, `scripts/manual/hub-admin-entry/accept.mts`, and `scripts/manual/smoke/smoke-hub-room-reload.mts`. Owned derivatives keep public routes real and inject only the boundaries stated above.

Supplemental checks: **12 focused files, 278/278 passing**, with unchanged process guard/global teardown. They supplement the browser stories and are not labelled browser or Windows evidence.

All selected campaigns: exit0, no owned live descendant PIDs, scratch temporary roots removed, zero native-guard violations. Overall post-run owned-resource scan and HOME removal are recorded in [cleanup.json](cleanup.json). Initial rejected fixture probes are disclosed above; none ran a real backend. No merge, deployment, publish, real account, live fleet or host lifecycle action was part of acceptance.
