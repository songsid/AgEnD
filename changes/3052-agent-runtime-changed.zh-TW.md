---
section: Changed
---
- Runtime 的本機與已配對 Windows 電腦採用一致的機器卡片。CLI 診斷改為各台電腦專屬的對話框，測試任務預設收合；關閉重開會保留草稿與已提交任務的歸屬。
- Runtime CLI 診斷可選擇已配對的 Windows 電腦，各台電腦分別顯示 CLI、工作目錄、模型與測試任務。離線時可查看已回報的清單，並停用新任務。
- Runtime 設定會在本機 CLI 摘要與診斷區顯示 Windows 電腦名稱，並標示診斷與測試任務使用 AgEnD 主機的 Windows CLI。名稱由 Windows worker 在手動偵測時回報，隨清單保留；舊清單會顯示名稱尚未回報，重新偵測後即可取得。
- 管理員在網頁上於已授權的 Runtime 新增一般 Agent 時，不再等待 General 確認卡。AI 提出的建立要求仍須核准；需要核准的 Windows 建立要求會使用整個 Fleet 的主要 General。
- Agent 設定對話框不再有 CLI 下拉選單：CLI 與 Runtime 一起顯示在「Runtime 與 CLI」區塊，並從**切換 Runtime／CLI**變更。CLI 已被移除的 Agent（例如 `gemini-cli`）會在該區塊標示「（已移除，請選擇其他 backend）」，對話框也會說明無法繼續的原因與替代的 CLI。
