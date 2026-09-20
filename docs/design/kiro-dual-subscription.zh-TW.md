# 一個 fleet 同時用 Amazon Q 訂閱與 Kiro 訂閱：可行性與 spec

狀態：**階段 1（機制核心）已實作**，見 `src/backend/credential-profile.ts`；其餘階段（General 可操作、profile-aware usage、session 處理）未實作。原始調查內容如下，所有結論對本機實際安裝的 `kiro-cli 2.22.0` 實測。

原始狀態：**調查回報，未實作**。所有結論對本機實際安裝的 `kiro-cli 2.22.0`（`~/.local/bin/kiro-cli`）實測，未修改任何既有登入狀態（每次實測都比對過真實 DB 的 mtime/size 未變）。

**結論先講：可行，而且比預期便宜**——`XDG_DATA_HOME` 就能完整隔離憑證，不需要換 HOME、不需要動 CLI。但有一個**不做就會很貴**的陷阱（同一個目錄裡混著 8.4GB 的 runtime 快取），以及一個**這支 CLI 本身不支援**的東西（同一份 DB 內的身分切換）。

---

## 查證點 1：auth SQLite 在哪、能不能搬

**位置不是 `~/.kiro/`。** 那是 Kiro **IDE** 的目錄（extensions / argv.json / sessions）。CLI 的資料在：

```
~/.local/share/kiro-cli/data.sqlite3      (本機 851 MB)
```

也就是 **`$XDG_DATA_HOME/kiro-cli/`**，預設 `$HOME/.local/share`。binary 裡確實有 `XDG_DATA_HOME` 與 `.local/share` 字串，且走的是標準 XDG fallback。

**兩個 env 都能重新定位，實測：**

| 設定 | 結果 | 真實 DB |
|---|---|---|
| `XDG_DATA_HOME=<tmp>` | 建出 `<tmp>/kiro-cli/data.sqlite3`，`kiro-cli whoami` → **Not logged in** | mtime/size **完全未變** |
| `HOME=<tmp>` | 建出 `<tmp>/.local/share/kiro-cli/data.sqlite3` **＋ `<tmp>/.kiro/settings/cli.json`** | 同樣未變 |

**兩者的差別很重要**：`XDG_DATA_HOME` 只搬「資料目錄」（憑證 + 歷史 + 快取），`~/.kiro/settings/cli.json` 仍共用；換 `HOME` 連設定檔一起搬，而且會牽動這支 CLI 讀 HOME 的其他所有行為。**建議用 `XDG_DATA_HOME`**：影響面最小、正好只涵蓋要隔離的東西。

另外查證：憑證**不在** `~/.aws/sso`。XDG 覆寫後 `~/.aws` 仍是真實的，CLI 依然回報未登入——所以 auth 單一來源就是那份 sqlite。

binary 裡另有 `_KIRO_HOME`（緊鄰 `.kiro`）與 `KIRO_API_KEY` 兩個字串，我**沒有**深入追查；前者看起來是 IDE home 覆寫，後者可能是另一條 API key 認證路徑。若之後想要更輕的方案，`KIRO_API_KEY` 值得再看一眼。

## 查證點 2：同一份 DB 能不能放兩個身分

**DB 裡確實同時存在兩組身分列**（`auth_kv` 表，4 列）：

```
codewhisperer:odic:token      + codewhisperer:odic:device-registration
kirocli:odic:token            + kirocli:odic:device-registration
```

**但這不是 profile 機制，是改名遷移的產物。** 本機這兩組的 `start_url` 完全相同（同一個 IdC 帳號），`codewhisperer:*` 那組已於 2025-11-18 過期，`state` 表裡有 `migration.kiro.completed = true`、`migration.kiro.was_q_user = true`。binary 字串也印證：`error occurred migrating builder id credentials`、`invalid_grant but peer token in store; returning peer's token`——後者表示兩把鑰匙之間是**單向 fallback**，不是可選擇的身分。

**CLI 沒有任何身分切換介面**（實測 `--help-all`）：

- `kiro-cli login` 的選項只有 `--license {free,pro}` / `--identity-provider` / `--region` / `--use-device-flow`；**沒有 `--profile`**。
- `kiro-cli profile` 只是**顯示**目前 IdC profile，不能切換。
- `kiro-cli user` 底下只有 `login / logout / whoami / profile`。

也就是 **login 是單一插槽**：同一份 store 同時只有一個有效登入，換帳號＝logout 再 login。

**所以「同一份 DB 兩個身分」不可行；唯一可行的是兩份 DB。** 而 Amazon Q 與 Kiro 是**同一支 binary**（`q` 只是 65 bytes 的 shim：`kiro-cli --show-legacy-warning "$@"`，`q --version` 印的也是 `kiro-cli 2.22.0`），所以兩個訂閱走的是同一支 CLI、同一種 store，只是各自登入——這正好讓「兩份 store」這條路成立。

## 查證點 3：AgEnD 這邊的成本

**比 codex 那次便宜，因為兩個前置條件都已經在了。**

1. **per-instance 選項的通道已存在**：`CliBackendConfig.backendOptions`（`src/backend/types.ts:46`）已經從 `fleet.yaml` 的 `backend_options.<backend>.<key>` 一路接到 backend——instance 覆寫 fleet 預設的合併在 `fleet-manager.ts:10339`，daemon 端在 `daemon.ts:5842`，codex 已經用它讀 `provider`（`codex.ts:240`）。**不需要新增 per-instance env 欄位。**
2. **啟動時 prepend env 的形狀已存在**：`codex.ts:251` 就是 `return \`CODEX_HOME=${shellQuote(...)} ${cmd}\``。kiro 的 `buildCommand`（`kiro.ts:237`）照做即可。

### 但有一個陷阱：kiro 的資料目錄裡混著 8.4 GB 的 runtime 快取

本機實際佔用：

```
kas            8.2 G
node           103 M
bun             98 M
cli-checkouts   56 M
data.sqlite3   851 M   ← 只有這個是憑證（+歷史/對話）
```

**天真地「每個 instance 一個 XDG_DATA_HOME」＝每個 instance 一份這些東西。** codex 的 CODEX_HOME 很小，所以那邊整份隔離沒問題；kiro 不一樣。

好消息是 codex 的既有做法正好給了答案，而且**極性相反**：codex 是「隔離小的 `config.toml`、其餘 symlink 回共用 home」，kiro 則是「隔離 `data.sqlite3`、其餘 symlink 回共用 data 目錄」。而且 `codex.ts:434` 附近的註解已經寫明一條血淚教訓：**SQLite 的 base DB 若被 symlink，會解析到共用路徑**——對我們正好，因為那代表 `data.sqlite3` **必須是真檔**（否則隔離失效），而 `kas`/`node`/`bun`/`cli-checkouts` symlink 回共用處是安全的。

### 建議形狀

```yaml
# fleet.yaml
instances:
  q-worker:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: amazon-q     # → <instanceDir>/kiro-data/<profile>
  kiro-worker:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: kiro
```

- `credential_profile` 未設 → **完全維持現狀**（不設 `XDG_DATA_HOME`，用共用 store）。這條讓改動對所有既有使用者是 no-op。
- 有設 → `buildCommand` prepend `XDG_DATA_HOME=<dataDir>/kiro-profiles/<profile>`，並在啟動前 `prepareIsolatedKiroHome()`：建目錄（0700）、把 `kas`/`node`/`bun`/`cli-checkouts` symlink 回共用 `~/.local/share/kiro-cli/`、**不碰 `data.sqlite3` 與其 WAL/SHM sidecar**。
- 放在 `<dataDir>/kiro-profiles/<profile>` 而非 `<instanceDir>/`：**同一個訂閱要能被多個 instance 共用**（使用者的訴求是「兩個訂閱各跑各的」，不是「每個 agent 一個帳號」）。這也是與 codex 形狀唯一該不同的地方。
- 登入方式：`XDG_DATA_HOME=<那個 profile 目錄> kiro-cli login`，跑一次即可；或之後由 `/login` 流程帶上同一個 env。

### 成本估計

| 項目 | 估計 |
|---|---|
| `kiro.ts`：讀 `backendOptions.credential_profile`、prepend env、`prepareIsolatedKiroHome()` | ~60–80 行（可直接參考 `codex.ts:391-440` 的 symlink pass） |
| `/login` 路徑帶上同一個 profile env | 小，但**要確認 login-controller 與 web-terminal 的 spawn 路徑都吃得到**（未查） |
| 設定驗證：profile 名稱白名單（會變成路徑） | ~10 行 |
| 測試 | 隔離目錄形狀、symlink 集合、未設時完全不加 env（mutation 應能紅） |
| 文件 | 一段 |

**半天到一天等級**，前提是下面兩個未知數先確認。

## 兩個我沒能實測的未知數（實作前必須先確認）

1. **`kas`/`node`/`bun` 是不是真的會在新的 `XDG_DATA_HOME` 底下重新下載。** 我只在隔離 store 跑過 `whoami`（只產生 28 KB 的空 DB），**沒有跑過 chat**——跑 chat 需要第二個訂閱登入，我沒有。所以「會重新下載 8.4 GB」是**依位置推論、不是實測**。上面的 symlink 方案讓這個問題不成立，但實作時應該先用一個真實登入驗一次。
2. **兩個訂閱端到端是否真能並行計費/計額度。** 我證明的是「store 可以分離、分離後 CLI 視為未登入」，**沒有證明**兩個不同訂閱同時跑不會在 AWS 端互相干擾（例如同一個 IdC 帳號下的兩種授權是否真能各自計額度）。這一條只有使用者拿兩個真實訂閱才能驗。

## 不建議的替代方案

- **OS 層隔離（不同 unix user / 容器）**：可行但太重——AgEnD 的 instance 是同一個 fleet 行程下的 tmux window，換 user 等於重做整個 spawn 模型。
- **登入/登出輪替**：`login` 是單一插槽，輪替代表每次切換都要重跑 device flow，且會打斷另一個 instance。不可行。
- **直接寫 `auth_kv`**：塞兩組 key 進同一份 DB——CLI 沒有選擇機制，只會走它自己的 fallback 邏輯，等於把行為壓在一個未文件化的實作細節上。不建議。

## 範圍備註

使用者提到的「固定綁定 vs 額度用完自動切換」：本 spec 只涵蓋**固定綁定**（哪個 instance 用哪個訂閱寫在 fleet.yaml）。自動切換需要「額度用完」的可靠訊號與一個切換動作，而切換在這支 CLI 上等於改 env 後重啟 instance——可以做，但那是另一票，且應該重用既有的 `model_failover` / backend-outage 那套形狀，而不是自成一格。
