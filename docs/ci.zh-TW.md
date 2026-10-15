# CI 覆蓋與排程

[English](ci.md)

## 一般檢查

一般的 `ci.yml` 與 `npm-rollback-proof.yml` 在 PR、branch push 使用 Linux runner。這兩份 workflow 的 macOS 安裝檢查在 release tag、手動執行與每週排程執行。一般事件完全不建立 Mac 格；測試步驟與支援的 Node/npm 版本維持相同。

| Workflow | PR / branch push | `v*` tag / 手動 / 每週 |
| --- | --- | --- |
| `ci.yml` install smoke | Ubuntu × Node 22.14.0、22、24、26 | 同樣的 Ubuntu 格 + macOS × 全部四個 Node 版本 |
| `npm-rollback-proof.yml` | Ubuntu × npm 9.9.4、10.8.2、11.6.2（Node 20.19.0）；PR 的路徑篩選保留 | 同樣的 Ubuntu 格 + macOS × 全部三個 npm 版本 |
| `data-downgrade.yml` | Ubuntu current → published 2.1.12 → current | 不加其他觸發；僅 Linux |

CI workflow 仍執行 CHANGELOG guards、typecheck/build、四個 unit shards、integration tests，以及 Node 20 preinstall rollback smoke。既有 docs-only 步驟判斷保留。所有 `v*` tag（包含預發版）都執行 macOS 格。CI 每週一 03:17 UTC 執行，npm proof 在 03:37 UTC 執行。每週失敗仍需調查，但不是 PR 或 branch push 的前置條件。

Runtime acceptance 與 runtime publishing 使用獨立 workflow，覆蓋依其定義；參見[私有 runtime 設計](design/1450-private-node-runtime.md)。

## 被新版本取代的 run 與 merge gate

CI、Gitleaks、data-downgrade、npm-rollback-proof 以 workflow + PR number 作 concurrency group。新 PR HEAD 取消舊 run，釋放其 runner。Branch push、tag、排程與手動 run 保留。

Merge gate 要求 exact head 的必要 checks 成功，也檢查該 head 上其他所有 check-runs，因此不接受 `skipped`。一般事件的 OS matrix 只建立 Linux 格：optional Mac check-runs 完全缺席，而非建立後跳過。必要的 `build` aggregate 永遠存在，仍拒絕失敗、取消、跳過或缺少的 Linux smoke 結果。必要 check 缺席仍是錯誤。

Runner 排隊時間隨 GitHub 容量改變。移出一般 run 的 Mac 格可減少這項依賴，但不保證固定的完成時間。

## 已發布的 2.1.12 來自快取的 tarball

Node 20 rollback smoke、`data-downgrade.yml`、runtime-acceptance 的 hop 與 Mac GUI rehearsal 都會安裝已發布的 `@songsid/agend@2.1.12`。每次從 registry 抓這個 tarball 都會算一次 npm 下載，所以 CI 只抓一次，存在 Actions cache（`.github/actions/published-agend-tarball`，key `agend-tarball-2.1.12-v1`）：

- 每次使用前，tarball 的 sha512 必須等於 registry 的 `dist.integrity`（`npm view`，是 metadata 請求，不算下載）。不符就讓 job 失敗，不會改去重抓。新抓的 tarball 要通過檢查才會存進快取。
- `scripts/ci/install-published-tarball.sh` 開著 npm 的 http log 安裝它；如果 npm 仍然抓了 `@songsid/agend` 的 tarball，步驟就失敗。依賴套件仍從 registry 取得。
- 快取命中時，action 的 log 會寫 `cache hit (agend-tarball-2.1.12-v1): no registry download of @songsid/agend`，安裝步驟會列出依賴套件的請求數，其中沒有我們的 tarball。

新的 pull request 會還原 base branch 存下的快取。要刻意丟掉它，把 key 的 `-v1` 加一。

### Rehearsal

Release rehearsal 若要在多個 leg 安裝同一個已發布版本，先 pack 一次再重複使用那個檔案，不要每個 leg 都用套件名稱安裝：

```sh
mkdir -p ~/.cache/agend-published && cd ~/.cache/agend-published
npm pack @songsid/agend@2.1.12      # 只有這一次會下載
bash <checkout>/scripts/ci/verify-published-tarball.sh ~/.cache/agend-published/songsid-agend-2.1.12.tgz @songsid/agend 2.1.12
# 每個 leg：
npm install -g --prefix "$PREFIX" ~/.cache/agend-published/songsid-agend-2.1.12.tgz
```

升級流程有改動時，演練要跑下列 leg。每個 leg 都分別從已發布的 2.1.12 和上一版 beta 升到 pack 好的候選版：

- **L**：使用者 unit，有使用者 bus。
- **N**：使用者 unit，沒有使用者 bus。更新會經由 `systemd/private` 上的 peer client。
- **S**：root fleet 用的系統 unit（`/etc/systemd/system/agend.service`）。從 2.1.12 升級時，refresh 必須把它的 `ExecStart` 改成候選版（#1884）。
- **D**：沒有 service 的 detached fleet。
- **Mac**：launchd。更新分別從 Agent 的工作階段、操作者的終端機，以及 `/update` 執行。

每個 leg 都要記錄更新前後 fleet 的 pid 與執行的程式。
