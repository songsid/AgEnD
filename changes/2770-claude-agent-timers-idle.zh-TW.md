---
section: Fixed
---
- Claude Code agent 自己這一輪做完後，就算背景 subagent 還在跑，也會被視為閒置。subagent 的計時每秒都會重畫，AgEnD 以前把這當成 agent 還在工作，結果送給它的訊息要等，儀表板也一直顯示忙碌，直到最後一個 subagent 結束。沒有背景 subagent 的 agent，判斷方式和以前完全一樣。
