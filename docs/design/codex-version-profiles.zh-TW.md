# Codex 版本處理：version-keyed profile + 結構式 fallback（hybrid）

狀態：設計稿，待 review。這一輪不動 production code。
相關：#953（短 CODEX_HOME / socket）、#978（未知畫面 fallback）、#964 / #931 / #947（busy row、status_line、footer）、#984 / #1017（exact-cwd resume、session lookup）、#1008（rate-limit nudge）、PR #1025（0.159 resume-loading guard）。

## 1. 為什麼要做

每出一個 codex minor，AgEnD 就有東西壞，而且都是「看起來正常、交付時才出事」：

- 0.157：`has_user_event` 語意跟我們假設的不同 → 每次重啟靜默失憶（#1017）。
- 0.157：`app-server-control.sock` 放在 CODEX_HOME 下，長路徑超過 SUN_LEN → 需要短 home（#953）。
- 0.157：`resume --last` 改成以 git repo 為範圍 → 兄弟 worktree 互搶 session（#984）。
- 0.159：header 拿掉外框 → resume-loading 的 input guard 不再觸發（PR #1025）。

這些判斷現在散在 `codex.ts` 各處。每條都是「看某種畫面形狀」，註解裡記著「在 0.15x 觀察到」，卻沒有任何地方知道**現在跑的是哪一版**。新版上線時我們不知道哪些判斷還成立，只能等它壞。

目標是讓「已知版本的行為」集中、可測；讓「未知版本」有一條明確、保守的路。

## 2. 現況盤點

最重要的事實：**目前沒有任何程式碼解析或比較 codex 版本號。**

- `probeCliVersion`（`backend/types.ts:143`）只在 `probeCLIEnv`（`codex.ts:2005`）被呼叫。結果寫進 `cli-env/codex.json` 快取，只拿來顯示。
- daemon 的 `backendVersion` 寫死 `null`（`daemon.ts:1582`），所以 `delivery_attempts.backend_version` 欄位一直是空的。
- 版本差異全靠：畫面形狀、舊版會忽略的 config key（`features.instant_interrupt`）、schema 檢查。

以下列出依 codex 版本或 TUI 格式而定的判斷（行號以 main 740ae26c 為準，PR #1025 合併後會小幅位移）。

### 2.1 啟動參數與寫入的 config

| 位置 | 判斷 / 控制 | 版本依據 |
| --- | --- | --- |
| `codex.ts` `buildCommand` | `resume <id>` / `resume --last` / fresh；approval flag | `--last` 的 repo 範圍（0.157，#984） |
| 同上 | `-c check_for_update_on_startup=false --no-alt-screen` | 0.155.0 / 0.156.1 確認支援 |
| 同上（PR #1025） | `-c features.instant_interrupt=false` | 0.159 才有；舊版忽略並列為 startup warning |
| `writeConfig` → `enableContextStatusLine` | `tui.status_line` 必含 `context-remaining`（#931） | footer 解析依賴它 |
| `disableStartupUpdateCheck` | top-level `check_for_update_on_startup = false` | 「verified in the binary」 |
| `hideRateLimitModelNudge` | `notice.hide_rate_limit_model_nudge = true` | 保留 runtime dialog 給「older or changed CLI behavior」 |
| `preTrust` / `codexTrustPaths` | 寫 `[projects."<root>"] trust_level` | 0.156 信任 worktree 的共同 repo root，而非 CWD |

### 2.2 CODEX_HOME、socket、app-server

| 位置 | 判斷 / 控制 | 版本依據 |
| --- | --- | --- |
| `shortHomeFor` / `resolveShortHome` | `~/.agend/cx/<hash>` 短 home 與遷移 | 0.157 的 `app-server-control.sock` 與 SUN_LEN（#953） |
| `prepareIsolatedHome` | 共用 home 的鏡射規則、SQLite sidecar 修補、session dirs（#506） | app-server-daemon 鏡射屬衛生問題（parked：wip/1017-codex-home-runtime） |
| `linkAuthFile` | `auth.json` symlink；codex 透過連結寫回 token | 「behaviour, though, not a contract」 |

### 2.3 Readiness / idle / busy / footer

| 位置 | 判斷 | 版本依據 |
| --- | --- | --- |
| `CODEX_CONTEXT_ITEM`、`isCodexContextFooter` | `Context N% left/used`（含被截斷的形式）、`⚠ N warnings`、`<uuid> · Context` | 0.156 窄 pane 截斷 |
| `CODEX_LIVE_STATUS_ROW`、`getBusyPattern` | `• <title> (… esc to interrupt)` | 0.156 / 0.157（#964） |
| `CODEX_STATUS_LINE_VALUE_PATTERNS` 等 | configured status_line 的 allow-list（#978） | — |
| `getBottomReadyPattern`、`isDeliveryInputReadyPane` | composer `›` + 最後一行是 footer | 0.153.4 / 0.156.0（#931 / #947） |
| `isPeriodicRedrawIdlePane` | 去掉 `⋆` 星空動畫再判 | 0.154 Astra theme |
| `getReadyPattern` | 三種 ready 形狀 | — |
| `isStableUnknownLayoutIdlePane` | 未知 footer 的 fallback（#978） | — |
| `getQueuedInputMarker` | `↳`（「submitted after next tool call」） | — |
| `daemon.ts` `isCodexLivePane`、`lateCodexSubmissionProof`、`UNKNOWN_LAYOUT_STABLE_MS` | 啟動 ready gate、投遞證明、未知畫面穩定時間 | — |

### 2.4 Transients 與 dialogs

| 位置 | 判斷 | 版本依據 |
| --- | --- | --- |
| `getInputUnavailableTransients` → boxed / unboxed resume-loading | 載入中暫緩投遞 | 0.154（吞 Enter）；0.159 無框（PR #1025） |
| `codexTrustPromptState` / `codexTrustVariantActive` | folder trust（有 Enter 自動按鍵） | 0.156 畫面；舊版文字另有變體 |
| `codexSessionLockVisible` | 🔒 lock 畫面（hold） | 0.156+；`f` fork 是 0.157 |
| `codexResumeCwdPickerVisible` | `Working directory · resume`（hold） | 0.157 |
| `codexUpdatePickerVisible` | update picker（自動 Escape） | 0.153.4 |
| `codexUsageLimitMenuVisible` | usage-limit 選單（自動 Escape，#945） | 0.156.1 |
| `codexRateSwitchVisible` | rate-switch picker（hold） | 0.156「wording/order 可能變」 |
| `codexUnknownSelectionVisible` | 未知選單（hold） | — |
| `login-flows.ts` `LOGIN_FLOWS.codex` | device-auth 流程文字 | 0.153.4 / 0.149 |

### 2.5 錯誤、額度、rate limit

`getErrorPatterns`：quota / 429 / 401 / usage limit / model metadata / capacity（#905）/ out of credits / 用量警告。文字格式依版本而定。另有 `instance-lifecycle.ts` 的 quota 驗證與 capacity baseline（#949）。

### 2.6 Session resume、state DB、rollout

| 位置 | 判斷 | 版本依據 |
| --- | --- | --- |
| `planResume` | 讀共用 home 的 `state_5.sqlite`（檔名寫死） | schema generation 5 |
| `codex-session-lookup.ts` | 欄位清單、SQL、`rolloutRecordsTurn`、`isUntouchedThreadEntry`、sibling 判斷 | 0.137–0.159 實測；未知格式判為 resumable（#1017） |
| `transcript-sources.ts` `CodexRolloutSource` | rollout 檔名、分片、`session_meta.cwd`、`response_item` 型別 | — |
| `delivery-reconciliation.ts` | user 輸入是 `response_item`/`message`/`role:user`/`input_text` | — |
| `tool-progress.ts` | `shell` / `exec` 呼叫、`mcp__agend_<instance>__` 命名 | — |

### 2.7 模型、用量、其他

- `listModels` / `getEffortLevels`：解析 `models_cache.json`（`slug`、`visibility`、`supported_reasoning_levels`）。`refreshModelCatalog` 呼叫 `codex debug models`（0.156.0 量測的 TTL）。
- `usage/providers.ts`：`wham/usage` API 格式（#936）。這是後端 API，不是 CLI 版本。
- `hideRateLimitModelNudge` + rate-switch hold 是現在僅有的 nudge 處理。原始碼裡沒有 `#1008` 字樣，0.159 上未驗證。
- `daemon.ts` `suspectsTransientMcpReplacement`：「Codex <0.146 tears down ALL MCP connections」。
- `delivery-queue-evidence.ts` `VERIFIED_QUEUE_RESUME_POLICIES.codex = {}`：以精確版本為 key 的表，但目前是空的。這表示「以版本為 key」的形狀已經有先例。

## 3. 設計

### 3.1 原則

1. **已知版本走 profile，未知版本走保守模式。** 不是純版號分派：版號只決定「用哪一組已驗證的判斷」，判斷本身仍是結構式的。
2. **未知 = 保守，而且一定讓人知道。** 未知版本或偵測失敗時：
   - 會擋輸入的判斷全部啟用；
   - 自動按鍵降級成 hold + 通知；
   - session lookup 維持 #1017 的 fail-safe；
   - 每個 instance 每個版本通知一次「此版本不在測試矩陣內」。
   - 絕不靜默。
3. **不改已驗行為。** #1017 的 resume 規則與 PR #1025 的 guard 原封搬進來。搬遷階段每一步都用現有 fixtures 證明分類結果不變。
4. **判斷是資料加小函式，不是一大包 if。** profile 只引用具名的 detector，detector 各自是純函式、各自有 fixtures。

### 3.2 版本偵測

**來源一：`codex --version`，每次 spawn 前。**

- 在 `buildCommand` 之前（daemon 的 spawn 路徑）以 `probeCliVersion` 取得並解析成 semver。
- 以 `(binary realpath, mtime, size)` 快取，同一個 binary 不重跑。二進位被升級時 mtime 會變，下次 spawn 自動重測。
- 成本：一次 `execFileSync`，5 秒上限，只在 binary 改變時才付。
- 可靠度：這是 codex 自己回報的版本，是最權威的來源。

**來源二：畫面 header，第一次 paint 之後。**

- 兩種 layout 都含 `>_ OpenAI Codex (vX.Y.Z)`（有框 `│ … │`，或無框兩格縮排）。
- 用來交叉驗證「實際在跑的 process」。
- 兩者不一致時（例如 PATH 上有兩個 codex，或 spawn 後才升級）：**畫面判斷以 header 版本為準**，並記一次 warning。

**時機與空窗：**

- spawn 前就有來源一，所以 loading 早期（header 還沒畫出來）已經有 profile。
- 來源一失敗（逾時、非零 exit、解析不出版本）→ **視為未知版本**，進保守模式，並通知一次。

**patch 版本：**

- profile 以 minor 範圍為 key（例如 `0.159.x`）。
- 只有在 fixture 證明同一 minor 內行為不同時，才加 patch 級的 override。
- 預設同一 minor 共用一份 profile。

**附帶效益：** 把版本寫進 `backendVersion`（`delivery_attempts.backend_version`），之後排查「哪一版出事」直接查得到。

### 3.3 Profile 裡放什麼

```ts
interface CodexProfile {
  id: string;                 // "0.159"
  range: string;              // ">=0.159.0 <0.160.0"
  header: "boxed" | "unboxed";
  detectors: {
    resumeLoading: DetectorId[];      // 例如 ["resume-loading.unboxed"]
    busy: DetectorId[];
    ready: DetectorId[];
    holdDialogs: DetectorId[];        // session lock、cwd picker、trust hold、rate switch、unknown selection
    autoKeyDialogs: DetectorId[];     // authorized trust (Enter)、update picker (Esc)、luna reserve (Esc)
    errors: DetectorId[];
  };
  launch: {
    flags: string[];                  // "-c features.instant_interrupt=false" 等
    configWrites: ConfigWriteId[];    // status_line、update check、nudge、trust
  };
  store: {
    stateDb: "state_5.sqlite";
    threadColumns: string[];          // 已驗證存在的欄位
    untouchedRolloutShape: string[];  // ["session_meta", "event_msg:thread_settings_applied"]
  };
  socket: { requiresShortHome: boolean };   // #953
  fixtures: string;                   // "tests/fixtures/codex/0.159/"
}
```

- detector 是 `src/backend/codex/detectors/*.ts` 裡的純函式，例如 `resume-loading.boxed`、`resume-loading.unboxed`、`busy.status-row`、`ready.context-footer`、`dialog.session-lock`。
- profile 只列出這一版適用哪些 detector 與參數。
- 已知 profile 共 5 份：0.155、0.156、0.157、0.158、0.159。
  - 0.155–0.157：`header: "boxed"`，resume-loading 用 boxed detector。
  - 0.159：`header: "unboxed"`，用 unboxed detector，並啟用 `instant_interrupt` pin。
  - 0.158：**還沒有真實 fixture**，header 形狀未確認。實作前要先用真 0.158 擷取，不能用推測填表。

### 3.4 未知版本（含偵測失敗）的保守模式

依判斷類型定義「保守」的方向：

| 類型 | 未知版本時 | 為什麼保守 |
| --- | --- | --- |
| 擋輸入（resume-loading、session lock、cwd picker、trust hold、unknown selection） | **所有已知 detector 取聯集**：任一判定要擋就擋 | 多擋一下只會延遲投遞；現有 `INPUT_TRANSIENT_STALL_MS` 30s / `INPUT_TRANSIENT_WAIT_MS` 10min 會讓它有上限，不會永久卡住 |
| 自動按鍵 dialog（trust Enter、update Esc、luna reserve Esc） | 偵測照做，**但降級成 hold + 通知**，不自動按鍵 | 在沒驗過的畫面上按鍵（尤其依位置選擇）是 #978 那類事故的來源 |
| busy | 聯集：任一判定 busy 就是 busy | 誤判 busy 只會晚一點投遞 |
| ready | 已知 ready detector 取聯集，但仍受 busy 否決；另有 #978 的穩定未知畫面 fallback | 每個 ready detector 本身都要求結構性證據，取聯集不會降低門檻 |
| 啟動參數 | 用最新已知 profile 的 flags，但只放「所有已知版本都接受或忽略」的 flag | 不能讓未知版本因不認得 flag 而啟動失敗 |
| session lookup | 不依版本，沿用 #1017：未知格式判 resumable，欄位缺失走 unreadable → fallback + 通知 | 已經是 fail-safe |
| 通知 | 每個 (instance, 版本) 一次 launch warning：「codex X.Y.Z 不在測試矩陣，保守模式運作中」 | 絕不靜默 |

### 3.5 跟現有程式碼整合

- `CodexBackend` 的公開介面（`getReadyPattern`、`getBusyPattern`、`getInputUnavailableTransients`、`getStartupDialogs`、`getRuntimeDialogs`、`getErrorPatterns`、`buildCommand`）**簽章不變**。內部改成「依目前 profile 組出結果」。daemon 端不用改。
- **#1017 session lookup**：不依版本，原樣保留。profile 的 `store` 只記「已驗證的欄位與空殼形狀」，給 matrix 測試用來斷言，不改變 lookup 行為。
- **PR #1025 guard**：boxed / unboxed 兩個函式直接變成兩個 detector。0.155–0.157 profile 引用 boxed，0.159 引用 unboxed，未知版本兩個都用。
- **#978 fallback**：`isStableUnknownLayoutIdlePane` 維持所有 profile 共用的最後一道防線。
- **#953 短 home**：`requiresShortHome` 目前所有已知版本都是 true。行為不變，只是有地方記錄。
- 版本註解（「observed on 0.156」）移到 detector 與 fixture 旁邊，由 fixture 證明，不再只靠註解。

## 4. 測試矩陣

- **fixtures 依版本分目錄**：`tests/fixtures/codex/<version>/`。每個支援版本至少要有：
  - `fresh`、`resume-loading`（有多種形狀就全部存）、`busy`、`idle`；
  - 以及能取得的 dialog 畫面（trust、session lock、cwd picker、update picker、usage limit）。
- **manifest**：`tests/fixtures/codex/manifest.json` 為每個 fixture 記錄預期分類（ready / busy / hold / transient / 哪個 dialog）。
- **matrix 測試**：
  - 每個 profile × 它自己版本的每個 fixture：分類必須等於 manifest。
  - 保守模式 × 所有版本的所有 fixture：擋輸入類與 busy 類，只要任一版本判定為真就必須為真；自動按鍵類必須降級。
  - 每個支援版本都必須有四種基本 fixture，缺一個測試就紅。這樣「宣稱支援卻沒有畫面證據」過不了。
- **單一來源**：real-codex e2e 的 `SUPPORTED_CODEX`（PR #1025）改成從 profile 表產生，不再手寫第二份清單。
- **mutation 必須紅的項目**：
  - 把某版 profile 的 detector 換成另一種 header 的 → 該版 fixture 紅；
  - 保守模式拿掉聯集 → 至少一個版本的 hold fixture 紅；
  - 自動按鍵在保守模式沒有降級 → 紅；
  - 版本偵測失敗時沒有進保守模式 → 紅。
- **擷取工具**：把這次 0.159 audit 的做法做成腳本 `scripts/codex-capture.mts <version>`。
  - 做法：npm prefix 隔離安裝、一次性 CODEX_HOME（symlink 登入）、私有 tmux socket、25ms 逐幀擷取 resume、跑一個極小的真實 turn、去識別化。
  - 輸出 fixtures 與 manifest 草稿，由人確認後提交。
  - 會花一個極小 turn 的額度，所以只在支援新版本時手動跑，不進 CI。

## 5. 分階段實作（每階段各自 review-gate）

| 階段 | 內容 | 行為變化 | 驗收 |
| --- | --- | --- | --- |
| P0 | 把散落的判斷抽成具名 detector（純函式）；現有 fixtures 搬進 `fixtures/codex/<version>/` 並補 manifest | **無**（純搬移） | 所有現有測試不變綠；matrix 測試對現有 fixtures 全綠；每個 detector 有 mutation 紅 |
| P1 | 版本偵測（`--version` + header 交叉驗證）、快取、寫入 `backendVersion`；profile 表建好，但所有版本暫時都用「目前的聯集行為」 | **無**（只記錄、不切換） | log / outbox 看得到版本；偵測失敗的測試 |
| P2 | 用真 0.158 補擷取；各已知版本改用自己的 profile；未知版本走保守模式與通知 | 已知版：不變（fixtures 證明）；未知版：自動按鍵改 hold + 通知 | matrix 全綠；保守模式的 mutation 紅；真 e2e 在 0.157 / 0.159 綠 |
| P3 | `scripts/codex-capture.mts`；`SUPPORTED_CODEX` 從 profile 產生；文件寫明「新 codex 版本的支援流程」 | 無 | 用腳本重新擷取 0.159，產出的 fixtures 與現有一致 |

建議 P0–P1 進 v2.1.8，P2–P3 視 review 結果再排。

## 6. 取捨與待決點

1. **偵測失敗時的預設**：本稿選保守模式（聯集 + 降級 + 通知），而不是「假設是最新已知版」。前者可能多擋、多問，後者可能在未知畫面上按鍵。請確認。
2. **per-instance override**：是否提供 `backend_options.codex.profile: "0.157"` 讓使用者強制套用某份 profile？建議提供，但只作為逃生口，而且套用時照樣通知。
3. **自動按鍵降級的範圍**：update picker 的 Escape 算相對安全（只會略過更新）。未知版本要不要保留它的自動 Escape？本稿先全部降級，比較簡單，也比較一致。
4. **過舊版本**：低於 0.155（尤其 <0.146 的 MCP 全拆）要拒絕啟動，還是保守模式照跑？建議照跑，但通知內容更強烈。
5. **擷取的額度成本**：擷取腳本需要一個真實 turn。只在「新增支援版本」時手動跑，不進 CI。
6. **範圍**：本稿只處理 codex。kiro 已經有 `versionAtLeast`，claude-code 等後端之後可以沿用同一套模式，但不在這一輪。
7. **0.158 fixture 缺口**：audit 只擷取了 0.159 與 0.157。0.158 的 header 形狀未知，P2 之前要先補。
