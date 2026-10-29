---
section: Fixed
---
- 商業工作區（business workspace）的 Codex 代理在額度用完或碰到擁有者設定的花費上限時，不會再停在 Codex 的「Request increase? / Notify owner?」提示上，也不會再出現「停在 CLI 對話框」警告和「需要你」項目。AgEnD 現在用 Escape 關掉提示（絕不替你通知擁有者），並以一則通知暫停代理：「Codex workspace credits exhausted — workspace owner must refill」或「Codex workspace spend cap reached — workspace owner must raise it」。排隊中的訊息會保留，補充額度後，下一則訊息或 `/wake` 就會讓代理繼續。喚醒時不會因為舊的錯誤行再次暫停。
