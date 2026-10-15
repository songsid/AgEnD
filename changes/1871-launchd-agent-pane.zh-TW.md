---
section: Fixed
---
- **macOS：從 Agent 工作階段裡執行更新，不會再讓 fleet 停住。** 在 launchd 上，`agend restart` 和 `agend update` 會先停掉 fleet，再重新啟動。如果指令是在 Agent 的工作階段裡執行，fleet 停下時會連同那個 Agent 一起被結束，第二步就沒有執行：fleet 一直停著，也沒有任何訊息。現在這類指令會改在背景繼續執行，輸出寫到 `~/.agend/service-activation.log`。中斷的更新用 `agend start` 救回之後，`agend restart` 以前每次都會拒絕；現在會重新啟動 launchd 正在執行的那個工作。(#1871)
