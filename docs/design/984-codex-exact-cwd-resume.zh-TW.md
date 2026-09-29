# #984 F3：Codex 以精確 CWD 解析 session 再 resume（窄版 #913）

狀態：設計稿，待 review。這一輪不實作。
相關：#984（本案）、#913 / PR #924（explicit-session resume，9/25 revert 於 8f4ee6ce）、#953（短 CODEX_HOME 遷移）、#506（sessions 必須與 terminal CLI 共用）、#978（未知畫面導致投遞判斷錯誤）、PR #985（F1 lock / 目錄選擇器 hold）。

## 1. 問題與證據

`CodexBackend.buildCommand()` 每次啟動都跑 `codex resume --last`。程式碼註解假設「每個 instance 的 working_directory 唯一，所以 session 不會互撞；沒有舊 session 就開新的」。在 codex 0.157.0 上，這個假設對 **git worktree** 不成立。

以下實測於 2026-09-29，使用真的 codex 0.157.0 與一次性 CODEX_HOME，session 為截短、改寫過 cwd 的複本：

| 情境 | `resume --last` 在 A 的行為 |
| --- | --- |
| A、B 是互不相關的目錄，B 的 thread 較新 | 選 A 自己的 thread，正確 |
| A、B 是同一 repo 的兩個 worktree，B 較新，未設 `resume_cwd` | **選 B 的 session**，並出現 `Working directory · resume` 選擇器 |
| 同上，設了 `[tui] resume_cwd = "current"` | **不詢問，直接在 A 接著跑 B 的對話** |

真實事故（Forge = doupo-server-codex）：

- Forge 與 designer-codex 是 `DouPo_Server/.git` 的兩個 worktree。
- Forge 的 `--last` 選到 designer 的 019feff4。designer 還活著，`~/.codex/thread-writer-locks/019feff4.lock` 被它持有，所以 Forge 停在 lock 畫面。
- 手動 `f` fork 後，新的 thread（01a0ebb6、01a0ebc6）在 `state_5.sqlite` 裡的 cwd 記的是 **designer 的目錄**。Forge 的 codex 子程序（MCP server）也跑在 designer 的目錄裡。
- 下次 designer 重啟，它的 `--last` 很可能拿到 Forge 的 fork，污染會連鎖下去。

目前 fleet 裡「與兄弟 instance 共用 git repo」的 codex instance 共 7 個：AgEnD（Prism、sol）、DouPo_Server（2 個）、AWP-OTA（3 個）。同 repo 內**新建**的 instance 第一次啟動就會拿到兄弟的 session。

## 2. 目標 / 非目標

目標：

- 同 repo 的兄弟 worktree 永遠不會 resume 到彼此的 session。
- 既有對話原樣找回：不搬移，不開新對話；只有原本就會拿到別人對話的情況例外。
- 不寫任何 codex state，不新增任何鎖。

非目標：

- 不隔離 `state_5.sqlite`、sessions、`thread-writer-locks`。三者維持 #953 的 symlink 共用。
- 不自動處理 lock 畫面或目錄選擇器。那是 PR #985 的 hold，需要人決定。
- 不自動清理已被污染的 thread，見 §8。

## 3. 為什麼不隔離 state_5.sqlite

- 根因是 codex 選 session 的**範圍**（repo），不是資料庫共用。
- 隔離 DB 但 sessions 目錄照舊共用，codex 可能以 `backfill_state`、`rollout_migration_state` 從共用的 rollout 重建索引，又撞回去。這點未實測，是風險不是結論。
- `thread-writer-locks` 是唯一防止兩個 writer 同時寫同一個 rollout 的機制，**必須共用**。隔離後 lock 畫面會消失，換來兩個 instance 真的同時寫同一個 session。
- 隔離會讓 terminal CLI 看不到 instance 的 session（#506），並迫使既有對話搬移（#913 revert 的理由）。

## 4. 設計

### 4.1 解析 session（唯讀）

啟動時（`buildCommand`，非 `skipResume`）先解析「本 instance 的 session」：

1. DB 路徑：`<sharedCodexHome>/state_5.sqlite`。
   - 讀共用 home 本身，不經過 instance home 的 symlink，避免依賴 link 是否存在。
   - credential profile 只換 `auth.json`，state 仍然共用，所以同一條路徑適用。
2. 開啟方式：`new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 })`。
   - WAL 模式下唯讀連線是安全的。
   - 不建立檔案，不 checkpoint，不寫入。
3. Schema 探測：`PRAGMA table_info(threads)` 必須含 `id, cwd, source, archived, recency_at_ms`，缺任何一個就走 §4.3 的失敗路徑。
4. 查詢：

   ```sql
   SELECT id FROM threads
   WHERE cwd IN (@wd, @wdReal)       -- 精確比對，realpath 正規化，兩種寫法都接受
     AND source = 'cli'              -- 排除 subagent（source 是 JSON）與 exec 等非互動 session
     AND archived = 0
   ORDER BY recency_at_ms DESC, updated_at_ms DESC
   LIMIT 1
   ```

   - `@wd` 是設定裡的 working_directory。`@wdReal` 是 `realpathSync(@wd)`，失敗時就只用 `@wd`。
5. 回傳前用 UUID regex 驗證 `id`。指令組裝仍一律 `shellQuote`。

### 4.2 啟動指令

- 找到 id：`codex resume <id> <既有 flags>`。
- 找不到：`codex <既有 flags>`，也就是全新 session。
  - **絕不 fallback 到 `--last`**：在 worktree 的情況下，`--last` 正是會拿到兄弟 session 的那條路。
- `skipResume`：維持現狀（全新 session）。

### 4.3 讀不到 schema 時的 fail-closed（leader 已定案）

「讀不到」涵蓋：檔案不存在、開檔或查詢失敗、SQLITE_BUSY 逾時、欄位缺漏。

- 本 instance 所在 repo **有兄弟 codex instance** → 開新對話，並 **warn**（log，加上一次性的 operator 通知）。
  - 理由：此時 `--last` 會搶別人的 session 並污染對方，比「對話看起來消失」更糟。舊對話仍在，可以手動 `codex resume <id>`。
- **沒有兄弟** → `resume --last`，並 warn。
  - 理由：此時 `--last` 等同今天的行為，是安全的，不該無謂放棄既有對話。

「兄弟」的判定：

- 對本 instance 與 fleet 內其他 backend=codex 的 instance 各跑一次 `git -C <wd> rev-parse --path-format=absolute --git-common-dir`。
  - 用 execFileSync，timeout 2s，每次啟動快取。
- 本 instance 的結果與任何其他 instance 相同，就是有兄弟。
- 本 instance「不是 git repo」視為沒有兄弟。
- git 逾時或其他錯誤視為「未知 → 當作有兄弟」，也就是開新對話並 warn，往不搶 session 的方向 fail-closed。

注意：只有 DB 讀不到時才需要判定兄弟；讀得到時一律用 §4.2，不需要 git。

### 4.4 與 F1 hold（PR #985）的關係

- 修完 F3 後，lock 畫面只會出現在真的重複開啟時，例如使用者在 terminal 開了同一個 session，或舊 process 殘留。
- 此時 PR #985 的 hold 會通知 operator，不自動按 `r` / `f`。
- `Working directory · resume` 選擇器在 `resume <id>` 且 cwd 相符時不會出現（§11 已實測）。若未來版本出現，一樣被 hold。

## 5. 對既有 session 的相容性

| 情境 | 今天（`--last`） | 本設計 |
| --- | --- | --- |
| 非 git 或單一 checkout，session 都在自己的 cwd | 自己最新的 thread | 同一個 thread（精確 cwd 的最新一筆） |
| 同 repo 兄弟 worktree，兄弟較新 | **兄弟的 thread**（lock 畫面或靜默劫持） | 自己的 thread |
| 同 repo 內新建 instance（自己沒有 thread） | **兄弟的 thread** | 全新 session |
| working_directory 改名或搬移 | 非 git：全新；git：可能拿到同 repo 的別人 | 全新。舊 thread 還在，可手動 resume |
| wd 經過 symlink | 依 codex 記錄 | `@wd` 與 `@wdReal` 都比對 |
| 只在 repo 子目錄開過 session，instance 在 repo root | 可能拿到子目錄的 thread | 不拿（精確比對）。這種邊界可接受 |

- 不搬移，不寫 sidecar，不做一次性切換。升級後第一次重啟，在非 worktree 情境下拿到的就是 `--last` 會拿的同一個 thread。
- 已知例外是已被污染的 thread，見 §8。

## 6. 版本耦合與測試

- 依賴 codex 內部 schema：`threads.{id,cwd,source,archived,recency_at_ms,updated_at_ms}`。
  - 以 **0.157.0 真實 schema 的空 DB fixture** 守住（只含 `CREATE TABLE`，不含資料），並加上 §4.1 的探測。
  - 欄位改名 → 探測失敗 → §4.3。
- 單元測試（production 的 lookup 函式 + fixture DB）：
  - 精確 cwd 選對。
  - 兄弟 worktree 較新時不選。
  - 排除 subagent、archived、非 cli。
  - realpath 兩種寫法都能比對。
  - 找不到時開新、不含 `--last`。
  - 欄位缺漏、檔案不存在、BUSY → 依兄弟與否走開新或 `--last`。
  - git 逾時 → 當作有兄弟。
  - UUID 格式不對 → 不採用。
  - DB 在查詢後內容不變（checksum）。
- 必須轉紅的 mutation：
  1. 改回 `--last`。
  2. 拿掉 `cwd` 條件，或改成前綴 / LIKE 比對。
  3. 拿掉 `source='cli'`。
  4. 拿掉 `archived=0`。
  5. 排序改成 ASC。
  6. 找不到時 fallback `--last`。
  7. 讀不到 schema、有兄弟時仍用 `--last`。
  8. 讀不到 schema、沒兄弟時開新。
  9. git 未知當作沒有兄弟。
  10. 以非 readonly 模式開 DB（測試斷言 readonly 旗標，並做 DB 不變的 checksum）。
  11. 拿掉 UUID 驗證。
- 真 codex 0.157 重現（opt-in，`AGEND_CODEX_E2E=1`；或附腳本由 reviewer 手動跑）：
  - 一次性 CODEX_HOME，兩個 worktree、兩個 thread，B 較新。
  - 用 production 的 `buildCommand` 產生指令，在獨立的 tmux server（`-L`）啟動。
  - 斷言畫面恢復的是 A 的對話，而且**沒有**目錄選擇器、沒有 lock 畫面。
  - 不送任何 prompt，不碰共用的 `~/.codex`。

## 7. 對照 #913 被 revert 的理由

| #913 被 revert 的理由 / 引入的東西 | 本設計 |
| --- | --- |
| 「失去對話比 `--last` 的 bug 更嚴重」 | 既有對話以精確 cwd 找回。會開新對話的只有兩種：原本 `--last` 就會拿到**別人**對話的情況，以及 DB 讀不到且有兄弟的 fail-closed（有 warn，舊 thread 可手動 resume） |
| 「遷移會把其他升級者推到新的 session」 | 沒有遷移，沒有 sidecar，沒有一次性切換。非 worktree 的升級者行為與 `--last` 相同（§5） |
| 保存 per-instance UUID 與驗證 sidecar、rollout metadata | 不保存任何東西，每次啟動從 codex 自己的 DB 唯讀查出 |
| OS 層的非阻塞 claim（留下 `~/.codex/.agend-session-claims`） | 不建立任何鎖或檔案。`thread-writer-locks` 仍由 codex 自己管理，維持共用 |
| 自動在目錄選擇器選「current directory」 | 不自動選，hold（PR #985） |
| 衝突時停止自動重啟、`agend fleet codex-resume`、#916 loop guard | 不需要。沒有 claim 就沒有衝突狀態；真的重複開啟時交給 lock hold |
| 升級時一次性的 EN/zh 通知 | 不需要。只有 §4.3 的 fail-closed 會 warn |
| terminal 可見性（#506） | sessions、state 仍共用，terminal `codex resume` 照樣看得到 |

## 8. 已被污染的 thread（一次性 operator 處理）

- 精確 cwd 查詢無法分辨「在 B 的 cwd 下、其實是 A 的對話」的 fork。
  - 例：01a0ebb6、01a0ebc6 記在 designer 的 cwd 下。designer 會選到 recency 最新的那一筆，可能就是 Forge 的 fork。
- 處理方式：
  - 由人判斷後，把錯誤的 fork archive 掉（codex 自己的 archive 功能），或在重啟前確認該 instance 的最新 thread 正確。
  - AgEnD 不自動改 codex state。
- 本設計上線後不會再產生新的污染：不再選到兄弟的 thread，選擇器與 lock 畫面也不自動按鍵。

## 9. Rollback

- 把 `buildCommand` revert 回 `codex resume --last`，一個 commit。
- 沒有資料要還原，沒有檔案要清。
- revert 後 §1 的 worktree 問題會回來，但 PR #985 的 hold 仍會阻止靜默 timeout 並通知 operator。

## 10. 實作分階段（每階段 review-gate）

1. **3.1** lookup 模組（純函式 + 唯讀 DB + schema 探測 + 兄弟判定）與單元測試、fixture DB、mutation 1–11。
2. **3.2** 接進 `buildCommand`。更新 codex.ts:731 附近的錯誤註解。warn 與 operator 通知的文字。
3. **3.3** 真 codex 0.157 重現腳本或 opt-in 測試。README / CHANGELOG 說明行為變更（worktree 兄弟不再互搶；同 repo 新 instance 從新 session 開始）。

## 11. 待確認

- 是否再加 `has_user_event = 1`，排除開了就關、沒有任何輸入的空 thread？傾向加上，避免「開新 → 空 thread → 下次 resume 空 thread」的情況。
- codex 0.156.x 的 `--last` 是否也以 repo 為範圍？手上只有 0.157.0。本設計對兩者都成立，不影響結論。
- 「同一個 checkout 的不同子目錄」（非 worktree）是否也會互撞？未實測。本設計以精確 cwd 比對，兩種情況都涵蓋。
- ~~`resume <id>` 在自己的 cwd 下是否會出現目錄選擇器？~~ 已實測（0.157.0，同一個 worktree 配置、兄弟 B 較新）：在 A 執行 `codex resume <A 的 id>`，直接恢復 A 的對話並進入可輸入的 composer（`› Ask Codex to do anything` + Context footer），**沒有**選擇器，也沒有 lock 畫面。§6 的重現測試仍會把這一點固定下來。
