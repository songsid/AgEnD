---
section: Fixed
---
- **用 `npm i -g @anthropic-ai/claude-code` 安裝的 Claude Code，現在 Windows Runtime 找得到了（#3234）。** npm 上 2.1.x 的 Claude Code 附的是原生 `claude.exe`，由 `claude.cmd` 直接執行；先前「重新偵測」認不得這種安裝，電腦會回報沒有安裝 Claude Code。現在 Runtime 只認這個固定的 npm 檔案配置（不會執行或解析任意 `.cmd`），並依電腦架構使用真正的執行檔。`npm install --ignore-scripts` 在 `bin\claude.exe` 留下的約 500 位元組佔位檔，永遠不會被執行。
