# 資料降版檢查：2.2 開發版 → 2.1.12

這是 #1441 Part C 的報告。**實測資料 store 可由 2.1.12 開啟、寫入，再由新版重新開啟；這不等於可安全 live 降版。** 舊版不執行多項新的安全政策，也不保留所有新功能。

## 證據與重跑

來源：新版 `34828033a007f8ef3cb22f07a96d12eb6d314069`；基準 `v2.1.12` commit `7a8160a12ac4024bffc5165b5b6e03af851cacf2`。舊版使用已發布的 `@songsid/agend@2.1.12`，沒有用新版依賴重建舊來源。

Linux x64 三階段成功：Node 22.22.2 / better-sqlite3 13.0.3 → Node 20.19.0 / better-sqlite3 12.11.1 → Node 22.22.2 / better-sqlite3 13.0.3。舊版依賴的實際 patch 版本有記錄；不宣稱 macOS、vendor CLI、session resume 或運行中 fleet 驗證。

本機 23 個 labelled group、build、test typecheck 通過；既有 focused 五檔 71/71。六個 compiled-JS counterfactual（schema version、ack metadata、舊 recovery、schedule deletion、normalized config loss、Kiro ownership）先 syntax check 通過，再直接 AssertionError 紅。這是 scratch build／installed-package probe，沒有宣稱六個 TypeScript mutation 或本機全套；所有變異 artifact 精確還原後往返再次通過。

```sh
npm ci
npm run build
# 先用 Node 20 把 @songsid/agend@2.1.12 安裝到可丟棄的明確 prefix。
node scripts/check-data-downgrade.mjs /scratch/prefix/lib/node_modules/@songsid/agend /scratch/node20/bin/node
```

Runner 自建唯一 scratch AGEND_HOME，依序執行三階段；每階段關閉所有 store，輸出版本與斷言，最後只刪自己建立的目錄。子程序環境採 allowlist，不繼承 bot token、NODE_OPTIONS 或 live IPC 路徑。每階段在 import production leaf module 前攔截 child_process。Kiro 只呼叫檔案操作的 prototype method，不建 constructor。不啟 fleet、tmux、adapter、inspector、service 或 backend。CI `data-downgrade.yml` 重跑並上傳 JSON。

## 結果

| 範圍 | 實測 | 限制／證據 |
| --- | --- | --- |
| Delivery outbox | `user_version` **5 → 4 → 5**，不重建資料表。新 consumed/acknowledged 欄位保留；舊版新增列的新欄位為 NULL。Admission 去重不變；舊版重啟恢復只重排未 begin 的 claim，已 begin 保留 `reconciliation_pending`。Integrity/FK 通過。 | 四個 TEXT 欄位及 attention index 為 additive（[新版](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/delivery-outbox.ts#L609)); [舊版直接寫 version 4](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/delivery-outbox.ts#L561)。舊版不蒐集新的 consumption/ack evidence，也無 Needs you；version 數字本身不是 schema fence。 |
| Scheduler／decision／task | 舊版可讀寫既有列與歷史，task completion 回新版仍可讀。未刪 schedule 的 retry 保留；舊版刪 schedule 會 cascade retry。Integrity/FK 通過。 | [Retry 表](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/scheduler/db.ts#L99) 為 additive、帶 ON DELETE CASCADE。舊版不實作新的 usage-deferred retry；回新版時保留的 retry 可能再被評估。Probe 不跑 timer，不保證相同排程。 |
| Event／activity／reaction | 舊版讀新事件、活動、消費 reaction，回新版可讀舊版新增事件。Integrity/FK 通過。 | [Store](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/event-log.ts#L47) API/schema 相容；不測 transcript 或 live delivery。 |
| Needs you | Live-message pointer 逐 byte 保留，回新版可讀；新建 hub 無 acknowledgement capability。 | [Pointer](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/needs-you-hub.ts#L201) 非持久授權；[registry 在記憶體](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/needs-you-hub.ts#L107)。2.1.12 無此 hub；既有聊天訊息／按鈕可能殘留，但舊版不能操作。 |
| #1423 pending | 只在記憶體；close 不執行 effect，新 store 無 pending。 | [Store](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/settings-confirmation.ts#L77)。未核准變更不轉移、不重播；在支援確認的版本重送。已提交設定仍在磁碟；舊 web handler 沒有新的 consent gate。 |
| fleet.yaml | Old raw loader 保留未知欄位及 channel 順序；effective loader 丟 `needs_you`、保留完整 nested `web`。Normalized load/dump 丟新頂層欄位與未知 extension。 | [新版](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/config.ts#L201)、[舊版](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/config.ts#L190)；重現舊 [topic bind/unbind](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/cli.ts#L1194) 的轉換。**不是所有舊 manager save 都丟資料**：[patch save](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/fleet-manager.ts#L7904) 重讀 raw YAML，保留無關 key。 |
| Kiro 檔案 | 新 agent JSON／.bak 經舊 writer/cleanup 後逐 byte 相同，回新版可辨 ownership。舊 shared writer 覆寫 foreign 同名 MCP／steering，cleanup 再刪除。 | [新版 ownership](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/backend/kiro-agent.ts#L80)、[舊 writer](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/backend/kiro.ts#L824)、[cleanup](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/backend/kiro.ts#L1214)。舊 runtime 不選新 per-instance agent；保留檔案不等於保留隔離。不測真 Kiro conversation。 |

### 政策與 state consistency 退化

- YAML 保留不代表 enforcement。`web.view_access: session` 雖被舊 loader 保留，舊 `/view` read 仍公開（[舊](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/view-api.ts#L212)、[新](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/view-api.ts#L224)）。Public link/session 與 sensitive-settings 功能需要新 runtime，能 parse 設定不代表已 backport。
- 新版 Classic admission 與 settings consent 比 2.1.12 新；降版恢復舊政策，包括 empty-list admission。這是安全政策 rollback。
- 舊 channel-array patch 用 index，無新版 connection identity check；並行磁碟 reorder 可能把權限改到另一 connection（[舊](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/fleet-manager.ts#L8012)、[新 fence](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/fleet-manager.ts#L9002)）。此項是 source audit，非 leaf runner 實測；rollback 時停用配置 writer。
- Legacy/TUI Kiro 回到 cwd-wide `--resume`，缺新版 per-instance selection（[舊](https://github.com/songsid/AgEnD/blob/7a8160a12ac4024bffc5165b5b6e03af851cacf2/src/backend/kiro.ts#L716)、[新](https://github.com/songsid/AgEnD/blob/34828033a007f8ef3cb22f07a96d12eb6d314069/src/backend/kiro.ts#L928)）。V3 原已有獨立 ownership；不宣稱所有 engine 都失去隔離。

## 建議與 rollback 界限

實測 store 不需要破壞性 DB 降版 migration。不要讓兩版 fleet 同時存取同資料。操作員核准降版前先停 fleet，保留 AGEND_HOME 的一致備份（含 SQLite WAL）、fleet.yaml/.env，以及 workspace shared Kiro MCP/steering、agent JSON／backup。Live 時只 cp 一個 WAL DB 並非一致備份。

保留 preimage：舊版 normalized YAML rewrite 或 shared Kiro write 會丟資訊。回新版可保留已測 DB metadata，但不能重建已丟 config、覆寫 workspace 檔、丟失 pending。整份還原舊 DB 備份亦會丟棄備份後的活動。用 2.1.12 對外開 web/channel 或共用 workspace 前，重新檢查政策。

本 PR 只改 verification script、CI、文件；revert 即可 rollback，無 production migration。Private Node bootstrap 與舊 updater 安全屬 #1446，本檢查不證明它們。
