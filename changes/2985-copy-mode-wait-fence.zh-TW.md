---
section: Fixed
---
- **等待 copy-mode 結束的送達 Enter，絕不會送進重啟後的 CLI。** 這段等待最長 10 分鐘。重新啟動 CLI 會沿用同一個 tmux 視窗，而 beta.5 的回退（#2985）拿掉了用來分辨「貼上時的 CLI」與「之後接手的 CLI」的檢查。現在若 agent 的 CLI 在等待期間被重啟，這個 Enter 就會放棄。(M-2290, #2985 follow-up)
