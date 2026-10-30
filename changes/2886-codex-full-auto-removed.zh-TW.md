---
section: Fixed
---
- `skipPermissions: false` 的 Codex instance 又能啟動了。Codex 拿掉了 `--full-auto`，這類 instance 一啟動就因為「unexpected argument」而結束。AgEnD 現在改傳這個旗標原本的意思：`--sandbox workspace-write --ask-for-approval on-request`。核准提示仍會等人處理，和以前一樣。
