---
section: Fixed
---
- `/login` 的瀏覽器終端監聽服務或 cloudflared 輸出管線失敗時，現在只會結束該次登入，並在聊天說明原因與下一步，不再讓整個 fleet 崩潰。公開連結失敗會保留 HTTP 429 的限流說明；本機連結也會說明 loopback、HTTP 與內網／WSL 的排查方式（#2243）。
