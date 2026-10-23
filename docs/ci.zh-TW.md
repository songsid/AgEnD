# CI 覆蓋與排程

[English](ci.md)

## 一般檢查

一般的 `ci.yml` 與 `npm-rollback-proof.yml` 在 PR、branch push 使用 Linux runner。這兩份 workflow 的 macOS 安裝檢查在 release tag、手動執行與每週排程執行。一般事件完全不建立 Mac 格；測試步驟與支援的 Node/npm 版本維持相同。

| Workflow | PR / branch push | `v*` tag / 手動 / 每週 |
| --- | --- | --- |
| `ci.yml` install smoke | Ubuntu × Node 22.14.0、22、24、26 | 同樣的 Ubuntu 格 + macOS × 全部四個 Node 版本 |
| `npm-rollback-proof.yml` | Ubuntu × npm 9.9.4、10.8.2、11.6.2（Node 20.19.0）；PR 的路徑篩選保留 | 同樣的 Ubuntu 格 + macOS × 全部三個 npm 版本 |
| `data-downgrade.yml` | Ubuntu current → published 2.1.12 → current，以及 current → published 2.2.6（用它自己附的 Node 22）→ current | 不加其他觸發；僅 Linux |

CI workflow 仍執行 CHANGELOG guards、GitHub Actions SHA 釘選檢查、typecheck/build、四個 unit shards、integration tests，以及 Node 20 preinstall rollback smoke。只有僅改動 `changes/` 片段的 PR 會跳過 typecheck/build 與測試（CHANGELOG guards 與釘選檢查仍會跑）；改到 `docs/` 或根目錄 `*.md` 的 PR 會全部執行，因為測試會讀這些檔案（#1932）。所有 `v*` tag（包含預發版）都執行 macOS 格。CI 每週一 03:17 UTC 執行，npm proof 在 03:37 UTC 執行。每週失敗仍需調查，但不是 PR 或 branch push 的前置條件。

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

## GitHub Actions 釘選（#2528）

`.github/workflows` 與 `.github/actions` 裡每一個遠端 `uses:` 都釘在 40 字元
commit SHA，版本 tag 寫在後面的註解：

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

本機 composite 維持 `./.github/actions/…`；它自己的遠端 `uses:` 一樣要釘。
Dependabot 的 `github-actions` 生態（`.github/dependabot.yml`，每週）會同時
更新 SHA 與註解：patch 與 minor 合在一個 PR；每個 major 單獨開 PR，讓
Node runtime 或 artifact 協定的破壞性變更可以分開審查。

`ci.yml` 的 `actions-pinned` job 每次事件都先 `npm ci --ignore-scripts`，再跑
`scripts/ci/assert-actions-pinned.mjs`，包含只改 changelog 片段的 PR。guard
用 lockfile 裡的 `js-yaml@4.3.2` 解析 YAML。`build` aggregate 在這個 job
不是 `success` 時失敗。

新增 action 時用 `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`
解析 tag（annotated tag 先走 `git/ref/tags` 再 `git/tags`），不要猜 SHA。
第三方 action 要在釘選的 commit 上審查；目前只有
`gitleaks/gitleaks-action`（商業授權，`node20`，`dist/index.js`，
`ff98106e4c7b2bc287b24eaf42907196329070c7` / v2.3.9）。

### 發布 workflow

`publish.yml` 只在推送 `v*` tag 時發布 `@songsid/agend`。
`workflow_dispatch` 只做驗證：checkout、`npm ci`、typecheck 與 build，
不會跑 `npm publish`。`publish-runtime.yml` 預設 `dry_run: true`，執行
`npm publish --dry-run`。除了真正發布 runtime 套件，不要把 `dry_run` 設成
false。

## npm registry 簽章（#2528）

`npm-audit-signatures.yml` 在 `npm ci --ignore-scripts` 之後，對根目錄與
`website/` 跑 `npm audit signatures --json`。簽章或 attestation 無效、兩者
混在一起、以及指令／解析失敗會讓 job 失敗；只有缺少簽章時只印出來、不失敗
（這是我們的政策：npm 10 對缺少與無效都會 exit 1）。這個 job 不跑套件 lifecycle scripts：`esbuild` /
`lightningcss` 的 postinstall，以及測試 job 裡的 native `install`（例如
`better-sqlite3`）仍由 `ci.yml` 與 `deploy-website.yml` 的完整 `npm ci` 執行。


## PR 的 dependency review（#2528）

`dependency-review.yml` 在進 `main` 與 `release/**` 的 pull request 跑
`actions/dependency-review-action`。PR diff 出現 high 或 critical 諮詢、
或新套件的授權不在 `.github/dependency-review-config.yml` 允許名單（目前
根目錄與 website 樹裡的授權）時失敗。偵測不到的授權只會被報告，不失敗。
