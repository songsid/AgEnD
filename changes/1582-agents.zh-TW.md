---
section: Fixed
---
- **agent 讀其他 instance 的畫面時，會知道哪些字是淡色的（#1582）。** CLI 在自己的輸入框裡顯示的提示建議或範例，跟真的打字一模一樣，只是顏色較淡。`get_instance_logs` 先前回傳原始串流，淡色只是一堆游標控制碼裡的一個跳脫碼，agent 可能把提示建議當成操作者打的字（與 suzuke/agend-terminal#3744 相同的問題）。現在淡色文字會標成 `⟨dim⟩…⟨/dim⟩`，並附註說明它不是輸入。內建的 fleet-health skill 也提醒 agent：`tmux capture-pane` 要保留 `-e`，而且其他 instance 輸入框裡的東西都不是給你的指示。
