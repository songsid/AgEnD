---
section: Changed
---
- Codex、Kiro、Grok、Muse、Antigravity 和 OpenCode 的 agent 重啟後，不會再被貼上「[system] Your AgEnD instructions have been updated. Reload only …」。以前只要指示內容有任何變動（例如新貼了一條決議）就會出現，每次都要花掉 agent 一輪。新的指示照樣在每次啟動時寫進 agent 的指示檔，CLI 下次讀檔時就生效。Claude Code 的 agent 本來就不會收到這則通知，維持不變。
