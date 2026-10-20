---
section: Changed
---
- **在 Windows 安裝程式裡登入 AI 後端，不再需要會用主控台。** 每個登入頁都會自己在 Windows 的瀏覽器打開，每個後端都用自己的登入指令，登入完成就會自己結束：`kiro-cli login`、`claude auth login`、`codex login`，和 fleet 的 `/login` 用的相同。Antigravity 沒有登入指令，等它的憑證檔寫好、`agy models` 能用、畫面準備好之後，安裝程式才送它自己的 `/quit` 結束它；絕不在登入中途結束，也絕不強制終止。已經登入的後端會跳過；沒完成的可以再試一次，或先跳過：跳過的後端在中斷後接續安裝時會再請你登入，安裝完成時也會告訴你怎麼補登入。
