---
section: Fixed
---

- Fleet 啟動會區分持久投遞佇列的鎖定、毀損、SQLite 原生驅動不相容與其他開檔失敗，並提供修復提示。AgEnD 不會隔離或重設佇列；啟動及新投遞仍被拒絕，不會丟棄待送訊息或提交證據。初始化／recovery 失敗會關閉其資料庫 owner，不發布未完成 recovery 的 store。 (#1490)
