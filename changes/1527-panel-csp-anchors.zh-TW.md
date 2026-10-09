---
section: Security
---
- **網頁 app：面板的安全政策不會再無聲地少掉 script nonce 或圖片來源（#1527）。** 每個面板送出的政策現在是延伸基礎政策中的完整指令；若缺少其中一條，AgEnD 會拒絕啟動，而不是送出 script 或 Discord emoji 圖片都會被擋下的頁面。
