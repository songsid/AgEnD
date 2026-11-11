---
section: Added
---
- **導出 Agent 設定，並從檔案載入範本。** 在「詳細資料與設定」›「基本資料」的 Agent 指示旁，**導出**會把這個 Agent 已儲存的可攜設定——描述、標籤、Agent 指示（只導出寫出來的文字，`file:` 引用不導出）、模型、工具組、輕量模式與行為調校——寫成 `<角色>.agend-agent.yaml`（`agend_export: 1`），有即時預覽，可複製或下載。只寫白名單內的欄位：帳號、API key、頻道與討論串 ID、工作目錄、機器 ID、權限類（`dashboard`、`skipPermissions`）、`pre_task_command`、Status emojis、顯示名稱一律不導出；描述或 Agent 指示疑似含有密鑰時，會擋下下載，移除後才能導出。**載入範本**可讀這種檔案（選檔或貼上），先預覽「將填入哪些、略過哪些與原因」，再填入表單——仍要按「儲存」並走原本的確認流程。檔案預留了 `library:` 區塊，之後給 Skill／工具庫使用。載入的檔案不會把 `file:` 引用填進 Agent 指示（它指向另一台電腦上的路徑），文字上限與編輯器相同，24,000 字元。超過上限的 Agent 指示不會放進導出檔（對話框會說明），所以檔案裡不會有自己讀不回的內容。`deploy_template` 與 `create_instance` 沒有 `instructions` 參數或範本鍵（Agent 指示就是 `systemPrompt`）；給了也會被忽略。
