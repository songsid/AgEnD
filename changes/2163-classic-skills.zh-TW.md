---
section: Fixed
---
- **ClassicBot 房間的 agent 讀得到通知提到的 skill（#2163）。** 2.3 的新功能通知會請每個 agent「載入 `web-appearance` skill」，但 AgEnD 從未把 skill 放進 ClassicBot 的工作區。現在：
  - Classic 房間自己那個由 AgEnD 管理的資料夾，會拿到與它的外觀和儀表板有關的 skill（`web-appearance`、`persona-emoji`、`web-dashboard`），不含任何管理 fleet 的 skill；位於其他位置的資料夾、或從該資料夾連到別處的連結，什麼都不會寫入，你自己寫的 skill 也絕不會被動到。
  - `agend-agent skill <name>` 在任何 instance 上都能印出 AgEnD 內建的 skill（`agend-agent skill` 列出全部），提到 skill 的通知也會說明這個方法。
  - 給 General 或 coordinator 的新功能項目，只會送給他們。
