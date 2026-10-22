---
section: Fixed
---
- 輔助程序的輸出管道讀取出錯時，不再讓整個 fleet 當掉。macOS 上 `/login` 解壓下載的 cloudflared 時若 `tar` 出錯，只會讓這次公開連結失敗並回報「無法把 cloudflared 安裝到 AgEnD 的資料夾」；在登入 shell 中查找後端 CLI 時若出錯，這次查找會當作找不到（#2243）。
