---
section: Fixed
---
- **按「登入」可能讓整個 AgEnD 卡死（#3212）。** 網頁終端機的輸出原本經由 FIFO 交給 AgEnD，由 tmux 的 `pipe-pane` 用 `cat` 寫入。在 Linux 6.6 上，GNU `cat` 對 FIFO 複製時會在等待更多輸出的同時持有管道的鎖，使 AgEnD 自己讀這個 FIFO 的動作卡在核心裡，登入程式一印出前幾行並等待輸入，整個程序就停住（「連不上 AgEnD」）。現在改用 `dd`，它不會持有這把鎖，輸出一到就傳過去（不使用 macOS 11.0.1 與 12.0.1 的 `dd` 不接受的 `status=` 運算元）。
