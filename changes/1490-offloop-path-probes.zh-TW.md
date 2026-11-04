---
section: Fixed
---
- **啟動 tmux 或包 `/login` 安裝時，fleet 不再用同步的 `accessSync` 走 PATH（#1490）。** 登入 shell 與 tmux/stty helper 改走既有的非同步 PATH 探測（可殺掉的子行程）。tmux PATH 探測期間被 Stop 時，該次改走直接呼叫，進行中的指令仍由正在排空的 helper 作答。`/login` 安裝在查登入 shell 時被關閉，就不會再開那個 session。找不到或沒有答案時，仍沿用繼承的 `$SHELL`，tmux/stty 仍改走直接呼叫。
