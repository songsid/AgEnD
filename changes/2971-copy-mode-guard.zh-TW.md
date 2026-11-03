---
section: Fixed
---
- **有人在 tmux 裡捲動代理的終端時，訊息不再被卡住沒送出（#2971）。** 連到 fleet tmux 的人若讓代理的窗格停在 copy-mode（正在捲動），tmux 會接走送到那個窗格的按鍵：訊息已貼上，但送出用的 Enter 被 copy-mode 吃掉，訊息卡著沒送出，AgEnD 卻以為已經送達。現在窗格處於 copy-mode 時，傳遞會等待，不送任何按鍵，也不會替對方離開 copy-mode；對方離開 copy-mode 後，訊息會送出一次。
