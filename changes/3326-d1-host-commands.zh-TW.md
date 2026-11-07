---
section: Changed
---

- **儀表板與通知不再叫人在主機上打指令（#3326）。** 同一畫面有替代路徑時，文案會指向那裡：立即重新啟動或在 General 傳 `/restart`、設定 → 帳號或 `/login`、Fleet、`/update`、`/web revoke`、全部登出，或該代理的 View 面板。web-only Fleet 不會提到 General，讀者就是擁有者時也不會請「這台電腦的擁有者」處理。最後手段的 CLI 仍只寫在文件與 `--help`。
