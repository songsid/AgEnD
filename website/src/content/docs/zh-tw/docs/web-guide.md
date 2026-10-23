---
title: 網頁使用說明
description: 登入 AgEnD 網頁儀表板、用手機開啟，以及登出。
---

Fleet 會在 AgEnD 電腦上提供網頁儀表板。網頁聊天和你在 Telegram 或 Discord 的聊天是同一段對話。完全沒有聊天 bot 的 fleet，也可以只用儀表板操作。

## 登入

在 General 傳 **`/web`**（fleet 管理員），再按登入按鈕：

- **💻 AgEnD 電腦登入（取碼）**：用 AgEnD 電腦本身的瀏覽器開啟。
- **🌐 其他裝置登入（臨時公開）**：用手機或其他電腦開啟。請先看[用手機開啟](#用手機開啟)。

bot 會私訊給你連結和登入碼；登入碼不會出現在 General。打開連結、輸入登入碼即可。登入碼只能用**一次**、**5 分鐘**內有效，而且只有最新的一組有效。

在 Telegram，你要先開過和 bot 的私訊，它才能傳訊息給你。如果傳不到，按**開啟私訊**，在 Telegram 按**開始**，再在那裡選登入按鈕。

**沒有聊天 bot？** 在 AgEnD 電腦上執行：

```bash
agend web          # 印出登入碼並打開登入頁
agend web --code   # 只印出來
```

如果瀏覽器沒有打開（伺服器，或沒有瀏覽器的 WSL），請用它印出的登入頁和登入碼。

## 用手機開啟

儀表板只在 AgEnD 電腦上監聽（`127.0.0.1`），所以手機打不開 💻 的連結。**🌐 其他裝置登入（臨時公開）**會透過 Cloudflare 開一個臨時公開連結：

- 按下去之前，什麼都不會公開。
- TLS 由 Cloudflare 處理，Cloudflare 看得到流量。**登入的人可以管理整個 fleet**：終端機、檔案、設定都可以。不要轉傳連結或登入碼。
- 連結 **2 小時**後自動關閉（可在設定改成 1–480 分鐘）。用自己的網域（具名 Cloudflare tunnel，`web.public_link.hostname`）時，網址每次都相同，連結最長可以開到 7 天，或直到你關掉為止。要提早關閉，按私訊或新的 `/web` 選單裡的**關閉公開連結**，或傳 `/web revoke`。
- 透過它的每一次登入都會在 General 通知。

公開連結關閉時（`web.public_link.allow_public: false`）不會有這個按鈕。這時請用你自己管理的連線，例如 SSH port forward 或 Tailscale：見[從別的裝置連線](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md#從別的裝置連線)。

## 登入期限與登出

- 在 AgEnD 電腦上的登入維持 **48 小時**，閒置 48 小時也會結束。兩者都可以在**設定 → 網頁**修改。
- 透過公開連結的登入維持 4 小時（閒置 30 分鐘就結束），連結關閉時也會結束。
- 用 `/web` 登入碼登入過的瀏覽器，下次登入頁會出現**傳一組新的登入碼給我**，不用再回聊天室取碼。
- 側欄最下方的**登入狀態**選單會列出 fleet 已登入的裝置（每台都有**登出**），以及**全部登出**。

看到不是你做的登入？讓所有瀏覽器登出：

| 在哪裡 | 怎麼做 |
|---|---|
| Telegram | `/web revoke` |
| Discord | `/web`，選 **`action: revoke`** |
| 瀏覽器 | 登入狀態 →**全部登出** |
| AgEnD 電腦 | `agend web-token rotate` |

## `/view` 預設公開

`/view` 會顯示每個 agent 的即時終端機、名單和用量。預設讀取它**不需要登入**（`web.view_access: open`）：連得到儀表板連接埠的人都能看你的 agent。只有你連得到的機器上沒問題；否則請要求登入：

```yaml
web:
  view_access: session
```

編輯 agent 的個人資料一定要登入；透過公開連結看 `/view` 也一定要登入。

## Windows（WSL）

AgEnD 在 WSL 裡執行。用 Windows 的瀏覽器開儀表板連結即可。

**只有在** Windows 打不開儀表板時（例如更新後），才需要確認是哪一邊有回應。先關掉儀表板分頁，再用同一個連接埠執行下面兩個指令：19280 是預設的 `health_port`，如果你改過，請換成你的。

```sh
# WSL 內
curl --noproxy '*' --max-time 5 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19280/health
```

```powershell
# Windows
curl.exe --noproxy "*" --max-time 5 -sS -o NUL -w "%{http_code}\n" http://127.0.0.1:19280/health
```

WSL 內 **200**、Windows **000**（完全沒有回應），指向 Windows 與 WSL 之間的轉送或連線問題，而不是儀表板登入的問題。一再重啟 fleet 不一定能修好。請保存兩邊的結果，以及 Windows 和 WSL 的版本，交給管理者。這段期間可以：

- 繼續用聊天；
- 或用 **🌐 其他裝置登入（臨時公開）** 從別的裝置登入；
- 或用你已經有的 SSH 連線進 WSL。

不要為了繞過它而把儀表板開放到網路上，或關掉登入。原因和管理者的處理選項見[完整說明](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md#windowswsllinux-有回應windows-卻連不到-dashboard)。

## 更多

其他內容（聊天、檔案、HTML 預覽、Fleet、等你處理和設定）見[網頁儀表板完整說明](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md)。
