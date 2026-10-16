---
section: Added
---
- **Agent 與 mod（#1629）。** `export_web_mod` 把 agent 自己的網頁外觀寫成工作目錄裡的 mod 檔案：它的主題與圖片、身分卡文字與小工具，絕不含自訂 CSS。`propose_web_mod` 把 mod 檔案送給人檢視：它會出現在 **設定 → 外觀 → Mod → Agent 提議的 mod**，按 **檢視** 進入一般的兩步匯入，按 **略過** 則捨棄。帶有自訂 CSS 的提議會被拒絕，agent 也永遠不能匯入。也可以用 `agend-agent mod export|propose`。
