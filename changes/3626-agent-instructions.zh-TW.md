---
section: Changed
---
- **Agent 的 System prompt 現在叫「Agent 指示」，放在基本資料。** 它是同一個欄位（`fleet.yaml` 的 `systemPrompt`，給 AI 的內容一字不差和以前一樣），只是改用文件的方式編輯：Markdown 的「編輯／預覽」切換、字數計（字元與 bytes；編輯時上限 24,000 字元）、Codex 讀 `AGENTS.md` 一共最多 32 KiB 的提示（超過約 16 KiB 會警告），以及「Agent 下次啟動時才讀」的說明。`file:` 引用照舊能用，頁面會把它顯示成它指向的檔案。它從「進階」搬出來，所以只有一個位置；ⓘ 和文件都會說它以前叫「System prompt」。儲存時的確認畫面對長文字只顯示字數、指紋與前幾十字，不再列出整份內容。不做任何資料搬移；Windows 原生 Agent 仍用自己的 system prompt 對話框。
