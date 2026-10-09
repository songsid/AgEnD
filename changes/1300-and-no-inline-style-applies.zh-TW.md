---
section: Security
---
- **……也只會套用頁面自己的 inline 樣式（#1300）。** `style-src` 也不再允許 `'unsafe-inline'`：每個面板的 `<style>` 區塊帶著同一個每次回應都不同的 nonce，而且所有面板都不再有 `style="…"` 屬性（dashboard 的已在 #1307 移除，/view 與 /settings 的在這次移除；即時終端的顏色與用量條改用 style 物件設定）。被注入的標記無法加上自己的 inline 樣式（但仍可能套用頁面既有的 class）。web terminal 維持它自己的政策。
