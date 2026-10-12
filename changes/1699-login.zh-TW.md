---
section: Added
---
- **在聊天室為 Claude Code profile 登入：`/login claude-code <profile>`（#1699）。**
  - 它會在 `/login claude-code` 用的同一個瀏覽器終端裡，為該 profile 執行 `claude auth login`，所以用手機也能完成。
    Discord 的 `/login` 多了 `profile` 選項。
  - 登入後只喚醒或重啟使用該 profile 的 agent。為預設登入重新登入時，也不再重啟使用其他 profile 的 agent。
  - agent 的 profile 登入過期時，警示會附上為該 profile 登入的按鈕。
  - Kiro 與 Codex 的 profile 仍要在主機上登入；`/login kiro-cli <profile>` 會回覆要執行的指令。
