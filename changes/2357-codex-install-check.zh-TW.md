---
section: Fixed
---
- **Codex：缺少 `codex-code-mode-host` 的安裝現在會被回報，instance 不再默默沒有回應（#2357）。** 官方套件會在 codex 執行檔旁附上這個輔助程式。只複製 codex 執行檔、少了它時，codex 仍能啟動、也收得到訊息；但如果帳號只能透過 code mode 使用工具，之後每一次工具呼叫都會失敗，AgEnD 的 reply 也一樣，畫面上只看得到 `⚠ N warnings · f2 to view`。現在 AgEnD 會在三個地方發現這個問題。`agend doctor` 會列出 **Codex 套件** 一列。每次啟動 codex 時，如果缺少這個輔助程式或它無法執行，就會通知一次，啟動不會被擋下。Codex 在 session 的 rollout 記下這個確切的工具失敗時，每次啟動同樣只通知一次。這項檢查只讀取套件的檔案配置，絕不執行 codex。修正方式是用完整的官方套件重新安裝 Codex。
