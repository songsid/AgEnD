---
section: Changed
---
- **AgEnD 在自己的 tmux 裡執行代理（M-2457）。** AgEnD 現在以 npm 套件 `@songsid/agend-tmux-<os>-<cpu>`（Linux 與 macOS，x64 與 arm64）自帶 tmux 3.8，並在自己的 socket `agend` 上執行。
  - **`tmux attach` 不會再看到代理。** 請改用 `agend attach [名稱]`，其他 tmux 指令用 `agend tmux <參數…>` 在 AgEnD 的伺服器上執行。你的 `~/.tmux.conf` 不再套用到它。
  - **安裝時檢查。** 安裝 AgEnD 時會檢查套件裡的 tmux（版本、檢查碼、在一次性 socket 上啟動再停止）。檢查失敗時，npm 會保留你原本的版本。
  - **不會退回使用主機的 tmux。** 沒有這個套件的主機會拒絕啟動並說明原因。要仍然執行，請把 `AGEND_TMUX_BIN` 設成 tmux 3.6a 或更新版本。
  - **升級。** 第一次啟動時，會先保存每段對話，再關掉代理在主機 tmux 上的舊視窗（絕不關掉主機 tmux 的伺服器本身），然後貼一則通知說明以上變更。無法證明屬於該代理的舊視窗只會擋住那個代理；`agend tmux-migrate --release <名稱>` 可放行它。
  - **退回 2.3.x：`agend rollback <版本>`。** 它會先關閉 AgEnD 自己的 tmux 伺服器並確認已結束，才安裝舊版。直接 `npm install -g` 舊版只在使用 systemd 的 Linux 上安全。
  - 詳見 [AgEnD 自己的 tmux](../docs/bundled-tmux.zh-TW.md)。
