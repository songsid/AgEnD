---
section: Fixed
---
- **`retireSystemCopy`：傳給 `sudo` 之前先解析 npm 的絕對路徑。** 原本 `sudo -n npm uninstall` 使用裸的 `npm` 指令，由 sudo 透過 `secure_path` 解析——可能找到不同版本的 npm 或根本找不到。現在先以 `sh -c "command -v npm"` 解析（使用與 runner 相同的 PATH），再將絕對路徑傳給 `sudo`。若無法解析 npm，則略過此步驟並給出明確說明。(#1490 P3)
