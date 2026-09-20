# Codex 的 credential_profile：查證與設計

狀態：**唯讀查證 + 設計，尚未實作**。對本機真實的 `~/.codex` 與 AgEnD 既有的 codex 隔離碼查證（只列目錄、讀 key 名與 SQLite schema，**沒有讀任何值、沒有寫入、沒有碰登入**）。

**結論先講：codex 跟 kiro 的結論相反 —— 切 profile 之後對話會留著。** 而且需要做的事比預期少很多：不需要 freshStart、不需要 context-handover、transcript 不用改。

---

## 1. 查證結果

### 1.1 auth 是一個獨立的純文字檔，就這樣

`~/.codex/auth.json`（4.2K）：`auth_mode`、`OPENAI_API_KEY`、`tokens.{id_token, access_token, refresh_token, account_id}`、`last_refresh`。

**整個 CODEX_HOME 底下，身分只存在於這一個檔。** 其他 30 個項目我都看過了（見 1.2），沒有第二處。這跟 kiro 把登入塞進跟對話同一份 `data.sqlite3`、而且還橫跨 `auth_kv` 與 `state` 兩張表，是完全不同的等級。

`config.toml` **不帶身分**：只有 `model`、`model_reasoning_effort`、`[projects."<path>"] trust_level`、`[tui]`、`[notice]`。

### 1.2 對話狀態不帶帳號欄位

四個 SQLite 的 schema（只讀 `sqlite_master` 與 `PRAGMA table_info`）：

| 檔 | 大小 | 關鍵 table 與欄位 |
|---|---|---|
| `thread_history_1.sqlite` | 207M | `thread_items(thread_id, turn_id, item_id, rollout_ordinal, item_json…)`、`thread_turns(...)`、`thread_history_projection_state(thread_id, next_rollout_byte_offset, next_rollout_ordinal)` |
| `state_5.sqlite` | 884K | `threads`、`projects`、`project_roots`、`thread_sections`、`thread_attachments`、`remote_control_enrollments` |
| `memories_1.sqlite` | 45K | `stage1_outputs(thread_id, raw_memory, rollout_summary…)`、`jobs`、`consolidation_progress` |
| `goals_1.sqlite` | 32K | `thread_goals(thread_id, goal_id, objective, token_budget…)` |

**沒有任何一張表有 account / user 欄位。** 全部以 `thread_id` 或 `project_id` 為鍵。也就是說這些庫**不是按帳號分區的**，它們只是「這台機器上跑過的對話」。

`thread_history_projection_state.next_rollout_byte_offset` 透露了架構：**SQLite 是 `sessions/` 裡 rollout JSONL 的投影**，JSONL 才是真相來源。這代表 `sessions/` 與那幾個 DB **必須同進同出** —— 一邊隔離一邊共用，投影狀態就會指向本 home 不存在的 byte offset。

`thread-writer-locks/<uuid>.lock`（目前 6 個）：每個 thread 一把 lockfile，codex 自己在序列化同一 thread 的寫入者。

### 1.3 AgEnD 早就在共用這些東西了 —— 而且已經踩過並修好 SQLite 的坑

`src/backend/codex.ts` 的 `prepareIsolatedHome()`：每個 instance 有自己的 `CODEX_HOME=<instanceDir>/codex-home`，然後把共用 home 底下**幾乎所有東西 symlink 進來**，例外只有 `config.toml`、MCP cleanup lock、以及 **SQLite 的 `-wal`/`-shm` sidecar**。

那段註解值得整段引用，因為它精確地界定了真正的危險：

> SQLite resolves a symlinked base DB to the shared path and creates its own adjacent sidecars there. Linking sidecars separately is redundant for shared bases and **corrupts the file set for private bases**.

**我先前對 leader 說「把這些 SQLite symlink 回共用正是 `CREDENTIAL_HOMES` 第一條警告禁止的」——那句話錯了，這裡更正。** 兩條規則講的是不同的事：

- `credential-profile.ts` 的第一條警告是關於**隔離**：「該私有的東西不能是 symlink」，因為 symlink 回去就等於沒隔離。它針對的是 kiro 的 store —— 那個檔**就是登入**。
- codex 的危險是**把一個 DB 的檔案集合拆散**（base 私有但 sidecar 連過去，或反之）。只要整組檔案都解析到同一個目錄，**共用 base 的 symlink 是安全的，而且 AgEnD 已經在 production 這樣跑了很久**。

codex 的對話庫不是登入，所以第一條警告根本不適用。

### 1.4 codex 透過 symlink 更新 auth.json，不會把它換成真檔

這是決定整個設計的一條經驗證據。AgEnD 已經在每個 instance 的 codex-home 裡把 `auth.json` symlink 到共用 home，跑了好幾個月：

```
agend-dev-sol-…        -> SYMLINK
awp-ota-backend-codex… -> SYMLINK
classic-鬥破企劃-7393   -> SYMLINK
…（本機 12 個 instance home，全部）
```

而共用的 `auth.json` mtime 是 2026-09-17，明顯被 refresh 過。**沒有任何一個 instance home 的 symlink 被換成真檔**，代表 codex 是就地寫入（或 rename 到 symlink 的 target），token refresh 會穿過 link 落在共用檔上。

這就是「profile 的 auth.json 可以是被 symlink 指向的那一端」的依據。**但它是觀察到的行為、不是保證的契約**：未來版本若改成 atomic rename，link 會被換成真檔、profile 的登入就此分叉且無聲。設計要有守衛（見 3.4）。

---

## 2. 結論：codex 切帳號**會**留著對話

- 身分只有 `auth.json`，換掉它就換了帳號。
- 對話／記憶／目標／sessions 全部不帶帳號欄位，而且已經被安全地共用著。
- 所以只換 `auth.json`，其餘照舊 → **兩個訂閱共用同一份對話歷史，切換後可以接著談。**

跟 kiro 相反，而且**兩個都不是政策選擇，是各自檔案佈局逼出來的**。

**但共用對話歷史是一個要裁的取捨，不是免費的**（見 §4 T1）：兩個訂閱多半是「公司／個人」，共用歷史代表任一邊的 codex 都看得到另一邊的 thread 與 memories。技術上沒問題，隱私上要人決定。

---

## 3. 設計

### 3.1 codex 的 profile 就是一個檔

```
<dataDir>/credential-profiles/codex/<profile>/auth.json
```

不是一個 home、不是一棵目錄樹 —— 因為 codex 的 home **已經因為別的理由被 relocate 了**（per-instance config 隔離），再 relocate 一次就會打架。

`prepareIsolatedHome()` 只改一件事：`auth.json` 這個 symlink 的來源，從共用 home 改成 profile 目錄。其他一行不動。

| 項目 | 目前 | 有 profile 時 |
|---|---|---|
| `config.toml` | instance 私有真檔 | 不變 |
| `auth.json` | → 共用 home | **→ profile 目錄** |
| `sessions/`、`archived_sessions/` | → 共用 home | 不變（所以對話續得下去） |
| `*.sqlite` base | → 共用 home | 不變 |
| `*.sqlite-wal/-shm` | 不 link | 不變 |
| 其他 | → 共用 home | 不變 |

### 3.2 `CREDENTIAL_HOMES` 需要一個形狀變體

現有的 spec 假設「用一個環境變數把整個 home 搬走」（`env` + `storeSubdir` + `isolate`/`share`）。codex 不是那個形狀：它的環境變數已經被 instance 隔離佔用，而要私有化的只有一個檔。

建議把 spec 拆成兩種 kind，而不是硬把 codex 塞進現有欄位：

- `kind: "relocate-home"` —— 今天的 kiro：搬 `env`，`isolate` 真檔、`share` 連回去。
- `kind: "redirect-files"` —— codex：不動任何環境變數，只把 `files: ["auth.json"]` 從 profile 目錄連進 backend 已經在用的 home。

`resolveCredentialProfile`、`credentialProfileHome`、`listConfiguredProfiles`、`instanceCredentialProfile`、validator、General skill **全部可以原樣共用**，差別只在 `prepareCredentialProfileHome` 分支。

### 3.3 不需要做的事（跟 kiro 不同）

- **不需要 freshStart**：新 profile 的 `sessions/` 就是共用的那份，`--resume`/rollout 照樣找得到這個 cwd 的對話。強制 fresh 反而是無謂地丟掉對話。
- **不需要 context-handover**：沒有東西斷掉。
- **`CodexRolloutSource` 不用改**：它讀 `process.env.CODEX_HOME || ~/.codex` + `/sessions`；daemon 自己的 env 沒有 CODEX_HOME，所以它讀共用的 `~/.codex/sessions`，而 child 寫進去的是同一個目錄（instance home 的 `sessions` 是指過去的 symlink）。profile 不改變這條路徑。**這是 kiro 那次要修的東西，在 codex 這裡本來就是對的。**
- **切換仍需重啟**：`auth.json` 在啟動時被讀，所以 `update_instance_config` 的既有重啟邏輯照用 —— 但用**不帶 freshStart** 的那條。

### 3.4 需要新增的守衛

1. **auth.json 變成真檔就是警訊**：`prepareIsolatedHome()` 已經有 `migrateDivergedSessionDir()` 這個先例。加一個對應檢查：若 `auth.json` 是真檔而非預期的 symlink，代表 codex 換掉了它（版本變更）→ 記錄警告並依 profile 重新連結，而不是無聲地讓登入分叉。這就是 1.4 那條「觀察到的行為不是契約」的保險。
2. **profile 目錄裡的 auth.json 必須是真檔**：沿用階段 1 既有的 symlink 檢查 —— 它若是個指回共用的 link，這個 profile 就是共用登入穿了件衣服。
3. **兩個 profile 不得同時寫同一份 auth.json**：不會發生（各自真檔），但值得有測試釘住。
4. **`thread-writer-locks/` 與 `-wal` 不受影響**：因為它們都留在共用 home、透過同一組 symlink 解析到同一個目錄，併發語意跟今天完全一樣 —— profile 沒有在這條路徑上引入任何新的共享寫入者。這點是「不做什麼」的守衛。

### 3.5 用量（分開計費驗證的重點）

`fetchCodexUsage()` 目前讀 `process.env.CODEX_HOME || ~/.codex` 的 `auth.json`。階段 3 的機制原樣可用：
- `usageBackendForProviderId("codex") → "codex"`；
- profile 的 store home 指向 `<dataDir>/credential-profiles/codex/<profile>`（`storeSubdir: ""`）；
- `fetchCodexUsage(storeHome?)` 加一個參數，跟 `fetchKiroUsage` 一模一樣。

→ `/usage` 會出現 `Codex (work)` 與 `Codex (personal)` 兩列，各讀各的 `auth.json`、各自打 `chatgpt.com/backend-api/wham/usage`。**這正是驗「分開計費」最乾淨的形狀**：兩列各自有 plan 與 window，對其中一個消耗就只有那一列動。

---

## 4. 要裁的取捨

**T1 —— 兩個訂閱要不要共用對話歷史？**
技術上共用是預設（什麼都不做就是共用），而且是 codex 能「切帳號續對話」的原因。但公司／個人兩個帳號共用同一份 `thread_history` 與 `memories`，代表任一邊都看得到另一邊。
- (a) **共用**（建議）：保住續對話，跟今天 instance 之間的行為一致，把隱私後果寫進文件與 General skill。
- (b) **連 sessions 與那幾個 DB 一起隔離**：完全分離，但那就退回 kiro 的體驗（乾淨新 session），而且要一次搬一整組互相依賴的檔（JSONL + 四個 DB + locks），出錯面大很多。
我建議 (a)，並且**在切換時明講「對話歷史是共用的」**，而不是讓使用者自己發現。

**T2 —— `CREDENTIAL_HOMES` 加 kind，還是給 codex 另開一條路？**
我建議加 `kind`（3.2）。理由是 General skill、validator、usage 枚舉、`listConfiguredProfiles` 全部不用分支，只有準備目錄那一步分。

**T3 —— 這票要不要順便把 `--resume` 對 codex 的語意寫清楚？**
codex 的 rollout 是 per-cwd 的 JSONL，跟 kiro 的 per-cwd 對話同構。既然共用，切 profile 後 resume 會接到**同一段**對話 —— 包括另一個帳號跑出來的部分。這是 T1(a) 的直接後果，要不要在切換回應裡明說，請裁。

---

## 5. 實作前還沒查的

- **沒有實跑過兩個 codex 帳號**（本機只有一個登入）。`auth.json` 換掉之後 codex 是否會因為 `account_id` 變了而拒絕既有 thread，我**無法在單帳號下驗證**。這是 T1(a) 唯一的實證缺口，等使用者確認有第二個帳號時要先驗這一條再實作。
- 沒有讀任何對話內容、memories 內容或 token 值。
