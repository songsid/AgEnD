---
section: Added
---
- **Windows 安裝程式可以另外安裝一個 AgEnD 專用的 Ubuntu。** 已經有 Ubuntu 的電腦上，建議的選項會安裝一個名為 `AgEnD`（或 `AgEnD-2`…）的 Linux，你原本的完全不動；其他選項是用原本的 Ubuntu（會修改它的設定），或直接結束。WSL 2.4.4 以上用 `wsl --install Ubuntu-24.04 --name`；較舊的 WSL 會先比對 Microsoft 官方映像檔的 SHA256，再匯入。之後的設定、兩個捷徑、`agend shortcuts` 和修復都用這個 Linux；下次執行會沿用它。兩個捷徑都會顯示它打開的 Linux 和使用者；`agend shortcuts` 要改指向別的 Linux 前會先詢問（#1853）。
