---
section: Fixed
---
- **安裝的一行指令在 root、沒有 sudo 二進位時也能裝 tmux（#2337）。** 第 3 步對 apt/dnf/pacman 寫死 `sudo`，最小映像裡的 root（Docker、部分 WSL/LXC）會變成 `sudo: command not found`。現在與編譯工具那步一樣用 `$SUDO`（root 為空）。非 root 且沒有 sudo 時，會清楚提示請先自行安裝 tmux 再重跑。
