# 指令權限

[English](command-permissions.md)

[指令介面矩陣](../command-surface.zh-TW.md) 記錄選單、處理、拒絕與文字路由。
[permissions.md](../permissions.md) 說明准入與憑證；[commands.md](../commands.md)
說明指令效果。

## 先准入，再驗指令權限

Discord 原生 slash 先通過 [`slash-authz.ts`](../../src/slash-authz.ts) 的來源／owner
門，再經 [`command-table.ts`](../../src/command-table.ts) 與 handler。DM 拒絕；
外部 guild 只容許既有 Classic context 或新 `/start`，且 Fleet admin 指令仍須在
bot 自己的 guild。另一 bot 不能處理其他 owner 的 Fleet channel；owning world
不可用時拒絕。明列 F 可通過 Fleet 准入，但 locked 加上空 F 清單不授予管理權。

Telegram General／Fleet 的文字 dispatcher 先辨識自己確實會處理的精確形式，
再由 `TopicCommands.tableRefusal` 驗命令表的 **Telegram** cell。未匹配形式仍是
普通文字。Classic Telegram 使用自己的 dispatcher 與角色檢查；群組裡未支援的
命令，須另有對話 mention 才會變成普通文字。

## 角色

| Level | 意義 |
|---|---|
| `anyone` | 已通過 ingress 的 caller；沒有額外 admin 角色要求 |
| `fleet-admin`（**F**） | owning bot YAML `access.allowed_users` 的明列 ID；無 target 時採 invoking bot。空清單不授權；不明 adapter 拒絕 |
| `classic-admin`（**C**） | 共用 `classicBot.yaml` 的 `defaults.admin_users`；空清單不授權 |
| `channel-admin` | Fleet／General 為 F；既有 Classic registration 為該 bot 的 F 或 C |
| `handler` | 新 `/start` 自己的准入：C 可直接啟動，或明列 guild／private-user grant；否則由 General 核准。Telegram group 保留 C 啟動權 |

Open／pairing 對話准入及 saved grant 不授予 F；chat allowlist 不授予 C。兩角色
維持不同：`/stop` 及 Discord Classic `/load` 須 C，既有 Classic context 控制
接受 F 或 C。Classic 新啟動 grant 空白時申請核准；既有 registration 照常可用。

## Scope 與 handler 例外

- Discord 每個 bot application 顯示全部 27 個原生指令，但沒有對應 agent 時，
  per-agent 命令拒絕。`/profile` 只限 General。
- Telegram 的 21 個 Fleet 選單項目由 General／instance topic 共用；Classic 選單
  有 10 個。隱藏的 `/cancel`、`/save` 與 Fleet `/raw` 仍有 handler。
- 已辨識的 Telegram Fleet-wide 指令在 worker topic 拒絕並指向 General。
  `/STATUS` 或 `/status report` 等沒有 handler 的精確形式維持普通輸入；
  `/restart`、`/visibility` 不分大小寫。
- Telegram Classic `/chat` 使用普通對話包裝，沒有專用命令 handler。
  命令表的 `anyone` cell 不會創造 handler。
- Discord Classic `/load` 未驗 backend 支援，對所有 backend 送出，不驗匯入成功。
  Classic Telegram raw 目前被共用 helper 擋住。本次不改能力；
  [#1458](https://github.com/songsid/AgEnD/issues/1458) 記錄以後的決策。
- 按鈕／選單另驗 nonce、地址與當下授權；之前執行命令的授權不代表後續 click
  已授權。claim 與 progress 後，來源 channel 都仍須對應該 target；
  clear 在移除按鈕後、首個 IPC effect 前，亦重驗 exact adapter、
  daemon／IPC owner 與 delivery epoch，且不提供 web mirror。
- Telegram no-thread General 在 dedup 前驗明確 bot suffix，即使沒有
  message ID 也一樣。錯誤或未知 receiver 靜默；bare command 與既有
  Classic／有-thread 的 username 行為不變。

## 更新介面

一起更新 `COMMANDS` 的正確平台 cell、真 handler 與兩語言矩陣。鎖頭由相關
命令表／選單 scope 產生，標籤不授權執行。保持 `command-surface-docs-1148.test.ts`
及 `command-gates-by-platform.test.ts` 真 handler 測試通過；不要以「較嚴格優先」
把 Discord 規則複製到 Telegram。
