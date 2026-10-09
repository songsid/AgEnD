---
section: Changed
---
- **`agend` 與 `agend-agent` 改由 launcher 啟動，由它決定 AgEnD 用哪個 Node 執行（#1450）。** 這兩個指令是很小的 POSIX `sh` 腳本，所以 PATH 上沒有 `node`（例如沒載入 nvm 的 shell）也能啟動。當版本為此平台釘選了 AgEnD 自帶的 Node（Linux glibc ≥ 2.28 x64/arm64、macOS 11 以上 x64/arm64），安裝時會驗證這個 Node（確切版本、N-API 10、在主執行緒與 worker 各開一次資料庫）並留下紀錄；之後 AgEnD 一律用它執行，不受 PATH 上的 Node 影響。系統的 Node、PATH 與 npm 都維持原樣。
  - 有自帶 Node 的平台上，系統 Node 的版本永遠不會擋下安裝或更新：Node 20、18、16，只要它的 npm 能跑安裝都可以，AgEnD 不會用它執行。只有兩種情況會拒絕安裝，此時 npm 會保留你原本的版本：
    - 此平台沒有自帶 Node（musl Linux、32 位元、其他作業系統、glibc 低於 2.28、macOS 11 以前），而系統 Node 又低於 AgEnD 的需求（`^22.14.0 || ^23.6.0 || >=24`），裝了也無法啟動；
    - 安裝過程中自帶 Node 沒通過驗證。
    在 Node 16 上，npm 8 還會替 better-sqlite3 跑 `node-gyp`（已有預建檔時什麼也不編），所以需要 node-gyp 的條件：Python 3（3.11 以下，或裝了 setuptools）與 `make`（macOS 為 Command Line Tools）。缺少時 npm 會中止安裝並保留原本的版本。Node 18 以上不會這樣。
  - 自帶的 Node 缺少、不完整，或驗證後被更動，會直接拒絕並印出修復指令；絕不默默改用別的 Node。
  - 安裝時跳過了自帶 Node（`--omit=optional`、`--ignore-scripts`）時，若系統 Node 符合需求就用它，並明確提示。
  - 可用 `AGEND_NODE=/絕對路徑/node` 指定；該 Node 必須符合需求，否則拒絕執行，不會退回其他 Node。
  - AgEnD 自己啟動的程式都用它正在執行的 Node 與它自己的 CLI 檔案，不再從 PATH 找 `node` 或 `agend`：各 CLI 啟動的 MCP server、沒有 service 時的 `agend start` 與 `agend restart`、quickstart 的重新載入、`/doctor`，以及 Antigravity 的狀態列。kiro、grok、muse 產生的 wrapper 中，路徑與參數都加上引號，含空白、`$` 或反引號的路徑會照原樣使用。
  - 不支援原生 Windows：請在 WSL 內執行 AgEnD。
