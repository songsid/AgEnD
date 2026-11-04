---
section: Fixed
---
- **啟動 tmux 或包 `/login` 安裝時，fleet 不再用同步的 `accessSync` 走 PATH（#1490）。** 登入 shell 與 tmux/stty helper 改走既有的非同步 PATH 探測（可殺掉的子行程）。找不到或沒有答案時，仍沿用繼承的 `$SHELL`，tmux/stty 仍改走直接呼叫。
