---
section: Fixed
---
- **拒絕格式錯誤的 named tunnel token（#2344）。** 設定 token 時會檢查解碼後的 Cloudflare 憑證結構，移除前後空白與引號，並以不洩漏憑證的提示說明格式錯誤。
