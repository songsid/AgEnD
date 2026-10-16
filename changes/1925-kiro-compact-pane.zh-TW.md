---
section: Fixed
---
- **從網頁對話送給 kiro 的 `/compact` 現在會說明何時結束（#1925）。** 在 kiro 的 classic 介面與 TUI 的 V2 引擎上，卡片會跟著 instance 自己的窗格：顯示**對話已壓縮**，或說明 kiro 沒有壓縮對話，原因是對話太短或壓縮被中止。在 TUI 上，「已壓縮」的意思是 kiro 的「Compacting conversation...」那一行出現後又消失了；除了「太短」之外的失敗分辨不出來。kiro 的 V3 引擎仍然會說明無法偵測壓縮何時完成。
- **kiro 文件不再說 instance 的 agent 不載入 steering（#1925）。** kiro 會替每個 agent 載入 `.kiro/steering`，即使 agent 設成 `resources: []` 也一樣，所以新對話也會讀到目錄裡的 steering 檔案。
