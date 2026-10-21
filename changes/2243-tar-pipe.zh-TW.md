---
section: Fixed
---
- macOS 上 `/login` 解壓下載的 cloudflared 時，若 `tar` 的輸出管道讀取出錯，現在只會讓這次公開連結失敗並回報「無法把 cloudflared 安裝到 AgEnD 的資料夾」，不再讓整個 fleet 當掉（#2243）。
