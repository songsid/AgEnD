---
section: Added
---
- **`agend tmux`（#3262）。** 在這個 fleet 自己的 tmux server（它的 tmux 執行檔與 socket）上執行 tmux 指令，例如 `agend tmux ls` 或 `agend tmux capture-pane -p -t <視窗>`，不必手動指定 socket。
