---
section: Fixed
---
- Claude Code agent 在背景跑 subagent 時又收得到訊息了。背景 agent 有兩個以上時，Claude 在輸入框下方列出的清單會讓 AgEnD 認不出輸入框，於是所有訊息、steer 和排程都要等這些 agent 全部結束才送得進去。現在訊息會直接交給 Claude，和沒有背景 agent 時一樣。
