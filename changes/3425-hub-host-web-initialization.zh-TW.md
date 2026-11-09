---
section: Added
---
- 新增僅限本機擁有者工作階段使用的 Hub 首次設定 API，沿用命令列的簽章初始化流程；密碼與私鑰只可寫入，儲存前會重新查核目錄身分與監聽埠，並在開啟監聽前將設定事件納入 Hub 稽核鏈。網頁表單將另行加入。命令列與網頁初始化都可略過 Hub 名稱。舊版程式會拒絕新的稽核資料格式；回復方式見[設計文件](docs/design/hub-host-web-initialization.md#required-audit-and-recovery)。
