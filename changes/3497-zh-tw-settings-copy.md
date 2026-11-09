---
section: Fixed
---
- **zh-TW Settings no longer shows raw config words or mixed English (#3497).** In zh-TW, these changes apply:
  - The remaining tool-progress and cross-Agent visibility selects (the Agent dialog and ClassicBot) use the same words as the Shared agent settings segments: 關／標準／詳細 and 完整／摘要／隱藏 (in English: Off/Standard/Verbose, Full/Summary/Hidden). The saved values are still `off`, `full` and so on.
  - Backend choices show the product name, such as "Claude Code" instead of `claude-code`, in every language.
  - The dashboard permission field is 「網頁儀表板權限」, matching the 網頁儀表板 section.
  - The remaining "backend", "model", "Mirror Topic" and lowercase agent/fleet in these strings are now Chinese, Agent or Fleet.
  - The search box reads 「搜尋設定：語言、金鑰…」.

  The page now marks its language from the start. A language chosen in the browser or on the device used to leave the page marked as English, so Chinese headings were upper-cased (「整個 FLEET」) and screen readers read the page as English.

  On a phone, the 「未驗證」 line under the message box is aligned with the box's text and has room above and below.
