---
section: Fixed
---
- **安裝的一行指令在使用者設定的 npm prefix 還不存在時，不再誤判需要 sudo（#2294）。** 以前像 `~/.npm-global` 還沒有 `lib/` 時，它會當成不可寫而改用 sudo，Linux 上沒有終端機就失敗，macOS 上非管理員帳號會卡住。現在改從最近一層已存在的上層目錄判斷可寫：那一層使用者可寫，或 prefix 在家目錄底下，就自己建立缺少的目錄。建立後依 `lib/node_modules` 或 `lib` 是否可寫決定要不要 sudo，prefix 本身可寫不會蓋過既有不可寫的 `lib`。真正不可寫的系統 prefix 仍維持原本的 sudo。
