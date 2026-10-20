---
section: Fixed
---
- **另一個 AgEnD 更新還在進行時，安裝的一行指令不再把它說成失敗（#2284）。** 之前它會接著顯示「Installation failed … run this installer again」。現在它會說明另一個更新正在進行中、等它完成即可（殼層語系是中文時顯示中文），並以代碼 75 結束。真正失敗時仍顯示原本的訊息。
