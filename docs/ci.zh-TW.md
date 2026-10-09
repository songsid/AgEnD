# CI 覆蓋與排程

[English](ci.md)

## 一般檢查

PR 與 branch push 使用 Linux runner。macOS 安裝檢查移到 release tag、手動執行與每週排程，避免 Mac runner 排隊拖慢一般 merge。這只改變 Mac 覆蓋的執行時機；測試步驟與支援的 Node/npm 版本不變。

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
