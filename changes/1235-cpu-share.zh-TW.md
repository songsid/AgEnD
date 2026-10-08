---
section: Changed
---
- **「Event loop stalled」警告現在會說明當時 fleet 是在忙還是在等（#1235）。** 警告會列出卡住期間 fleet 程序本身拿到多少 CPU，以及主機的負載平均。CPU 接近卡住的時間，代表是 fleet 自己的工作卡住；遠低於它，代表 fleet 在等：主機被其他工作佔滿（例如同一台機器上的大型測試），或卡在緩慢的系統呼叫。`docs/diagnostics.md` 說明如何解讀這則警告。
