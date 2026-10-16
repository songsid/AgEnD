---
section: Changed
---

- 將尚未推出的 HTML 特效原型改為 Canvas Worker：特效程式接觸不到 DOM、輸入欄位或焦點 API，啟動卡住及關閉時會終止 Worker，解碼後的素材合計以 8 Mi 像素為限。這是 2.3 的基礎工程；特效庫、註冊表與安全限制完成前仍不掛載特效。
