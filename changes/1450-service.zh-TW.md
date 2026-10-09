---
section: Changed
---
- **服務會寫明 AgEnD 自己的 Node，而 `agend restart` 會拒絕無法證明的服務（#1450）。**
  - systemd unit 與 launchd plist 現在啟動的是 `<AgEnD 的 Node> <套件>/dist/cli.js fleet start`，不再交給 `#!/usr/bin/env node` 和服務的 PATH 決定 Node。
  - 沒有自帶 Node 的平台，服務改為啟動 AgEnD 的 launcher，每次啟動時從服務的 PATH 找 Node，所以用 nvm 或 Homebrew 升級 Node 不會讓服務壞掉。
  - `agend restart` 在停止任何東西之前，會確認 systemd 或 launchd 已載入的定義正好是這樣，且沒有待重新載入的變更；否則拒絕，什麼都不停止。舊的服務請執行 `agend install` 重寫。`--force` 是給管理者用的。
  - macOS：`agend install --no-activate` 不再把新的 plist 留給 launchd 在不確定的時間點載入。它會驗證 plist 並記錄一次預定的啟用，由下一次 `agend restart` 只做一次 `bootout`/`bootstrap`；新的 job 沒有跑起來就回復到先前的 job。AgEnD 使用的 launchd domain（`gui/<uid>`）及原因，請見 `docs/cli.zh-TW.md`。
  - macOS：`agend install` 與更新會等 launchd 把先前的 job 完全卸載後才載入新的 job。launchd 在 `bootout` 完成前就先返回，立刻載入曾因此失敗（錯誤 5）。
