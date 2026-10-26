---
section: Added
---
- **用 Docker 執行 AgEnD：`docker compose up` 就能在容器裡得到可用的 fleet（#581）。** 這是第二種快速安裝方式；要長期使用的伺服器，仍建議用 systemd 或 launchd 服務。映像檔包含 AgEnD、Node.js 和 tmux。第一次啟動時，會把 `fleet.yaml` 用到的 AI CLI 安裝到 home volume。claude-code 與 kiro-cli 可以固定版本。它以一般使用者執行，由 Docker 的重新啟動政策監管。儀表板在 `http://localhost:19280/`，用 `docker compose exec agend agend web --code` 取得登入代碼。在容器裡，`agend update` 與 `/update` 會改提示 `docker compose pull && docker compose up -d`，`agend restart` 則讓 Docker 重新啟動 fleet。映像檔尚未發佈：請依 [用 Docker 執行 AgEnD](docs/docker.zh-TW.md) 在 checkout 用 `docker/build-from-checkout.sh` 建置。
