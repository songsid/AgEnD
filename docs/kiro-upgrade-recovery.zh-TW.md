# 升級後認領 Kiro 對話

啟動紀錄從 2.1.11（#1171）引入。從 2.1.10 或更早版本升級，或 instance 此後尚未啟動過，可能有對話卻沒有
啟動紀錄。#1624 只在以下條件全部成立時，允許一次性的認領：

- kiro-cli 支援 per-instance agent（2.21+，具備 `--agent` 與 `--resume-id`）；
- 該 instance 沒有身份狀態或啟動紀錄；
- fleet.yaml **及** classicBot.yaml 中，沒有其他已設定的 Kiro instance 共用同一實際 cwd，包括已停止者與
  symlink 別名；
- 所選引擎儲存區中最新的對話尚未被認領。

接著會記錄正常身份、專屬 claim 與啟動紀錄，往後只用該 ID 恢復。已有舊式啟動紀錄者仍走原本的認領流程，
也涵蓋先升級 AgEnD、日後才將 Kiro 升至 2.21 的主機。舊版 Kiro 照舊執行；讀不到或損壞的紀錄不算缺少紀錄。
歸屬不明時會記錄 fresh、開新對話並通知原因一次，不會修改 Kiro 的舊對話。

已存在的 fresh 身份、刻意開新對話、換引擎／cwd／登入 profile，都不會重新使用此升級 fallback。後續仍只依
原有證據規則接手新對話。Classic／TUI 儲存區缺少資料不表示可以跨引擎認領；V3 身份政策不變。

## beta.1 已記錄 fresh 身份時

不會自動修復，因為覆寫身份可能丟棄使用者刻意開的新對話。若操作者已確定原對話 ID：

1. 停止 fleet 並確認已停止，備份 `AGEND_HOME/kiro-identity/`、`kiro-engine-ledger.json` 與 Kiro 儲存區。
   不要為了復原 AgEnD 的歸屬而修改 Kiro 的執行中資料庫。
2. 找到 `kiro-identity/instances/` 下的身份檔：檔名是 instance 名稱的 SHA256 前 32 個十六進位字元加 `.json`。
   核對 `instance` 欄位及正確的 `keys` 項目 `[engine, canonical cwd, credential profile]`。只從相同引擎／profile
   儲存區查原 ID；Classic 使用 `conversations_v2` 的 `key`、`conversation_id`、`updated_at` 即可。
   不要從其他引擎或別人的歷史推測 ID。
3. 確認 `kiro-identity/claims/<engine>/<原ID>` 不存在。其他 instance、不完整或已放棄的 claim 都不能覆寫；
   選定 record 的 `abandoned` 也不得列有原 ID。
4. 以 exclusive create、0600 權限建立原 ID 的 claim，內容是 instance 名稱與最後的換行。在正確 record 將
   `id` 設為該 ID、`agentConfirmed` 設為 `false`，保留其他 key 與歷史欄位，目錄維持 0700。若要替換已認領的
   新 ID，保留其 claim 並標記 abandoned（`<instance>\nabandoned\n`），也加入該 record 的 `abandoned`，
   不要釋放讓其他 instance 接手。任何寫入失敗，都先還原備份再啟動。
5. 啟動 fleet，確認命令帶 `--resume-id '<原ID>'`。對話維持存檔時的 agent（`/agent swap` 已暫停，#1800）；確認
   instance 在原本的對話回答。

這是已知 ID 的離線手動歸屬修復，不是自動遷移，也不保證執行中降版安全。
