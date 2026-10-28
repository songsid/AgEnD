---
section: Fixed
---
- 使用私人 SQLite 歷史保存 `fleet.yaml` 與 `classicBot.yaml` 最近五份有效原始內容。YAML 損壞時會建立一筆 Needs you，繼續使用執行中的設定；下次啟動可使用該檔案儲存的有效副本，不會覆寫損壞的原檔。YAML 損壞且沒有可用歷史時會明確失敗；結構驗證錯誤維持現行政策。
