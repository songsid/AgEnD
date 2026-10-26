---
section: Added
---
- **在 Docker 中執行 AgEnD 的操作手冊（#581）。** [在 Docker 中執行 AgEnD](docs/docker.zh-TW.md) 是寫給 agent 看的：交給 General 或任何 agent，它就會替你在容器裡架設 AgEnD 並持續維護。內容包含要詢問的問題、Dockerfile 與 compose（非 root、具名 volume、儀表板在 `127.0.0.1:19280`）、安裝與固定 AI CLI 版本、第一份 fleet.yaml、驗證、以重建映像檔更新、升級 CLI、備份、記錄與疑難排解。General agent 會有一個指向它的 `docker-install` skill。AgEnD 本身沒有任何 Docker 專屬的程式。
