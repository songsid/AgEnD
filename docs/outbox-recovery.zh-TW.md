# 投遞佇列修復

[English](outbox-recovery.md)

AgEnD 資料目錄的 `delivery-outbox.db` 保存待送訊息、attempt 與提交證據。
開檔或 boot recovery 失敗時，AgEnD 會記錄路徑、錯誤類別及修復提示。
`startAll` 在讀取 fleet 設定或啟動 instance 前拒絕繼續；失敗的 store 不會發布給投遞 admission。

| 類別 | 修復方式 |
|---|---|
| `busy` | 檢查另一個 AgEnD 行程或資料庫工具是否持有 transaction；待其完成後重試啟動。 |
| `abi` | 以 AgEnD 支援的 runtime 重新安裝（`agend update --force`）後重試。刪除資料庫無法修復原生驅動不相容。 |
| `corrupt` | 先停止 AgEnD，一併備份資料庫與存在的 `-wal`、`-shm` 檔案，再還原可信備份或修復副本，最後才明確替換。 |
| `other` | 查看 `daemon.log` 的原始錯誤，檢查權限、磁碟空間與儲存 I/O。 |

AgEnD 不會因開檔失敗而隔離或替換佇列。這個 store 與選用的
`events.db` 歷史不同：自動重設會丟失投遞證據。正常 SQLite 開檔與 schema migration
仍可能寫入健康資料庫，SQLite 也會在開檔嘗試中自行管理 journal 檔案。初始化失敗會關閉已取得的 connection；recovery 失敗也會關閉未發布的 store。

還原較舊備份可能丟失待送訊息或已提交的證據。請保留原檔供檢查，在重試前核對不確定的投遞。
此修改提供診斷，不會修復 SQLite 毀損，也不保證還原備份後不會重複提交。
