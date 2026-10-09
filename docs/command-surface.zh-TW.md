# 指令介面與授權

[English](command-surface.md) · [指令參考](commands.md) · [准入與憑證](permissions.md)

以下表格區分選單可見、AgEnD 處理、拒絕與普通文字路由。已對照 main `572bf39f9a4d98ed0d1fa78b414d07c7c9f54295`；角色與命令路徑和下列固定版本來源相同。

## 儲存格怎麼讀

- `H:A`：AgEnD 處理；caller 必須先通過 ingress，無額外 admin 要求。
- `H:F`：target owning bot 的明列 Fleet admin；沒有 target 時是 receiving bot。空 YAML 清單不授予任何 F。
- `H:C`：共用 `classicBot.yaml defaults.admin_users`；空清單不授予任何 C。
- `H:F/C`：既有 Classic registration 接受該 bot 的 F 或 C。
- `H:start`：新啟動的專用准入；C 可直接啟動，其他人須有明列 guild/private-user grant，否則向 General 申請。Telegram group 啟動仍須 C。既有 registration 不變。
- `R`：消費命令並回拒絕／找不到 agent；`R:G` 指向 General，`R:active` 表示已有 Classic agent。
- `P`：沒有 AgEnD command handler，正常 ingress/routing 可能把原文字交給 agent。
- `S/P`：已加命令 suffix 的 Classic group 訊息，沒有另外的對話 mention 就靜默；另有 mention 才作普通訊息。
- `S/R`：未註冊 Classic chat 靜默；另有 bot mention 時回沒有 agent。
- `R(C)` / `R(F)`：未註冊 chat 的 handler 先檢查 C／F，再回沒有 agent；未註冊時 C 單獨不能通過 F-or-C helper。
- `*`：不帶 mode 的 `/tips` 是資訊命令；變更設定的 mode 另需 F。

✓ 是設定會註冊的選單，不是授權。所有 H 格仍受 backend 能力、參數、生命週期及來源限制。Telegram 選單註冊在整個 forum chat，因此 General 與 instance topic 共用建議。Discord 每個 bot 全域註冊全部 27 條；平台註冊失敗可能留下舊選單。

## Discord native slash

| 命令 | 選單 | General | Fleet topic | Classic | 未註冊 guild channel |
|---|---|---|---|---|---|
| `/profile` | ✓ | H:F | R | R | R |
| `/start` | ✓ | R | R | R | H:start |
| `/stop` | ✓ | R | R | H:C | R |
| `/chat` | ✓ | R | R | H:A | R |
| `/load` | ✓ | R | R | H:C | R |
| `/pause` | ✓ | H:F | H:F | H:F/C | R |
| `/wake` | ✓ | H:F | H:F | H:F/C | R |
| `/compact` | ✓ | H:F | H:F | H:F/C | R |
| `/clear` | ✓ | H:F | H:F | H:F/C | R |
| `/model` | ✓ | H:F | H:F | H:F/C | R |
| `/effort` | ✓ | H:F | H:F | H:F/C | R |
| `/collab` | ✓ | H:F | H:F | H:F/C | R |
| `/save` | ✓ | H:F | H:F | H:F/C | R |
| `/steer` | ✓ | H:A | H:A | H:A | R |
| `/btw` | ✓ | H:A | H:A | H:A | R |
| `/cancel` | ✓ | H:A | H:A | H:A | R |
| `/ctx` | ✓ | H:A | H:A | H:A | R |
| `/status` | ✓ | H:F | H:F | H:F | H:F |
| `/restart` | ✓ | H:F | H:F | H:F | H:F |
| `/login` | ✓ | H:F | H:F | H:F | H:F |
| `/update` | ✓ | H:F | H:F | H:F | H:F |
| `/doctor` | ✓ | H:F | H:F | H:F | H:F |
| `/dashboard` | ✓ | H:F | H:F | H:F | H:F |
| `/visibility` | ✓ | H:F | H:F | H:F | H:F |
| `/sysinfo` | ✓ | H:A | H:A | H:A | H:A |
| `/usage` | ✓ | H:A | H:A | H:A | H:A |
| `/tips` | ✓ | H:A* | H:A* | H:A* | H:A* |

## Telegram typed commands

| 命令 | 選單 G/T | 選單 Classic | General | Fleet topic | Classic private | Classic group | 未註冊 private/group |
|---|---|---|---|---|---|---|---|---|
| `/profile` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/start` | — | ✓ | P | P | R:active | R:active | H:start |
| `/stop` | — | ✓ | P | P | H:C | H:C | R(C) |
| `/chat` | — | — | P | P | P | S/P | S/R |
| `/load` | — | — | P | P | P | S/P | S/R |
| `/pause` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/wake` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/compact` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/clear` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/model` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/effort` | ✓ | — | H:F | H:F | P | S/P | S/R |
| `/collab` | ✓ | — | H:F | H:F | P | S/P | S/R |
| `/save` | — | — | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/steer` | ✓ | ✓ | H:A | H:A | H:A | H:A | R |
| `/btw` | ✓ | ✓ | H:A | H:A | H:A | H:A | R |
| `/cancel` | — | — | H:A | H:A | H:A | H:A | R |
| `/ctx` | ✓ | ✓ | H:A | H:A | H:A | H:A | R |
| `/status` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/restart` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/login` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/update` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/doctor` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/dashboard` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/visibility` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/sysinfo` | ✓ | — | H:A | R:G | P | S/P | S/R |
| `/usage` | ✓ | — | H:A | R:G | P | S/P | S/R |
| `/tips` | ✓ | — | H:A* | H:A* | P | S/P | S/R |

## 定址、未綁定 topic 與其他文字

- Discord DM 拒絕全部 native slash。外部 guild 只容許新 `/start` 或既有 Classic context；即使是 Classic，Fleet admin 操作及改設定的 `/tips` 仍拒絕。另一 owning bot 的 Fleet channel 會拒絕，即使 caller 同時是兩個 bot 的 admin。
- Discord Fleet/General 的純文字 `/xxx` 由 owner 回使用 slash menu 提示並消費；Classic 純文字 slash 靜默。receiving username 已知時，指向其他 bot 的 suffix 靜默。
- Telegram Classic group 須用 `/cmd@ThisBot`；**bare slash 全部靜默**，包含 `/start`。receiving username 已知時，其他 bot suffix 靜默；private 接受 bare 形式。既有 Classic／有-thread 路徑在 username 不明時仍放行 suffix。在 receiving Telegram bot 自己的 group，no-thread General 在共用 dedup 前驗明確 suffix：錯誤或未知 receiver 靜默，即使沒有 message ID 也一樣；bare command 仍走 receiving General。命令 suffix 不等於對話 mention。
- 辨識採精確形式：`/STATUS`、`/status report`、`/update now`、`/pause one two` 等在 Fleet/General 仍是普通 agent 訊息；`/restart` 與 `/visibility` 不分大小寫。這是已測試釘住的既有行為，與「正常 `/status` 在 worker topic 被轉送」的舊 bug 不同。
- Telegram `/sys-info`、`/sys_info` 是 General `/sysinfo` 別名；`/install-cli`、`/install_cli` 是 General `/login` 別名。都不在 menu。`/sys-info`、`/sys_info` 只辨識**無 suffix 的精確形式**，加 `@bot` 仍是普通文字；install 別名接受 suffix。worker topic 內已辨識的 General 別名會指向 General。
- Telegram Fleet `/raw <text>` 不在 menu，經 F gate 後走 raw delivery。`/raw@bot ...` 是普通包裝訊息，不會绕過 raw gate。Classic `/raw <text>` 拒絕非 C；C 目前也沒有成功的 native raw 路徑，因 `/chat /raw ...` 被共用 helper 丟棄。Group 的某些 mention 形式只是普通包裝訊息。能力維持不動；[#1458](https://github.com/songsid/AgEnD/issues/1458) 記錄延後的決策。
- 已設定的 Telegram forum 內，未註冊 topic 回未綁定提示，不走表中的 Classic 未註冊 chat 欄。沒有 General 時 no-thread 訊息可能靜默。
- General `/pause`、`/wake` 須指定自己 bot 擁有的 instance；General 本身不可 pause。已授權的 Fleet restart/status/login/diagnostics 與設定仍作用於共用 fleet/host；owner 授權不代表作用範圍只限單一 world。
- Discord `/load` 沒有 backend check，會向**所有 Classic backend** 送 `/chat load <filename>`。Kiro 有這個原生命令；其他 backend 可能拒絕或把它當輸入，AgEnD 不讀取或驗證回應。AgEnD 的提示只證明送出，不保證匯入成功；[#1458](https://github.com/songsid/AgEnD/issues/1458) 記錄延後的能力決策。
- Classic menu／新啟動 grant 與既有 registration 的聊天准入不同。Open/pairing 不授予 F；C 是跨 bot/platform 共用清單。Classic approval 可 fallback 到另一 General，由該 General 的 F 決定。
- 若磁碟上的 Telegram Classic entry 有 `collab: true`，普通轉送會進 Discord mention 判準，TG/private 文字可能靜默。正常 Telegram start 不會開此 flag。

## 按鈕與選擇器

按鈕另有自己的 handler gate；menu 可見及先前 slash 命令的授權都不代表後來 click 已授權。

| 介面 | 實際 gate |
|---|---|
| Cancel | current owner／目的地／訊息；已准入的 Fleet speaker，或既有 Classic 對話參與者 |
| Model / effort | opener＋adapter/channel＋當下 owner/admin；claim 與 progress update 後，來源 channel 都仍須對應此 target |
| Clear | Classic 的 F 或 C、其他 context 的 F；精確 nonce/world/message；button retirement 後、clear IPC 前重驗當下 role、來源 target、adapter、daemon/IPC owner 與 delivery epoch |
| Tip feedback | 有身分 caller＋精確 nonce/world/message；advanced unlock 另需 F |
| Login / hang / exit / Classic approval | F＋精確 nonce/world/message，並使用各請求既有的 ownership 檢查 |
| Dashboard / Settings confirmation | current owner F、nonce，以及 requester／authority fence |

**Clear 不提供 web mirror**：`listWebPrompts` 不含其 nonce，`clickWebPrompt` 拒絕它；本次不新增 web clear 准入。

來源：`src/fleet-manager.ts:10443`、`:11592`、`:14413`、`:14719`、`:11126`。過期或不明 callback ID 不授權。

## 維護矩陣

`tests/command-surface-docs-1148.test.ts` 以命令表檢查兩語言的命令 cell 與選單，並明列 Classic 真 handler 的例外。`tests/command-gates-by-platform.test.ts` 驅動真 handler。規則、選單或路由改變時，兩份文件一起更新；不要由 Discord cell 推論 Telegram 有對應 handler。

no-thread General suffix 與 callback 的 await 後 fence 拒絕已過期或無法確認的來源；既有角色模型與精確形式 passthrough 維持不動。首個同步 IPC／config effect 核准後，沿用既有 backend／restart 行為。

## 核對來源

- [`src/command-table.ts:116`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/command-table.ts#L116) — 27 command rules / 27 條命令規則
- [`src/command-table.ts:215`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/command-table.ts#L215) — 21/10 Telegram menus / Telegram 選單
- [`src/channel/adapters/discord.ts:1117`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/channel/adapters/discord.ts#L1117) — Discord global registration / 全域註冊
- [`src/topic-commands.ts:1896`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/topic-commands.ts#L1896) — Telegram registration scopes / 註冊 scope
- [`src/fleet-manager.ts:3347`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L3347) — Discord door → table → handler
- [`src/fleet-manager.ts:3531`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L3531) — Discord source/owner door / 來源與 owner
- [`src/fleet-manager.ts:3281`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L3281) — Explicit fleet admin / 明確授權 F
- [`src/topic-commands.ts:580`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/topic-commands.ts#L580) — Telegram table enforcement / 授權表接線
- [`src/topic-commands.ts:526`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/topic-commands.ts#L526) — Exact typed forms / 精確文字辨識
- [`src/fleet-manager.ts:6915`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L6915) — Telegram Classic real dispatch / 實際路由
- [`src/classic-channel-manager.ts:483`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/classic-channel-manager.ts#L483) — Empty Classic start grants / 空准入清單

- [`src/fleet-manager.ts:6767`](https://github.com/songsid/AgEnD/blob/5ccbf10d11d4698fd3a4682e16fd4d843054aabf/src/fleet-manager.ts#L6767) — No-thread General suffix / 無 thread 的 General 定址
- [`src/fleet-manager.ts:11150`](https://github.com/songsid/AgEnD/blob/aec3af6180eff478a5b560513c5ee2909595bedb/src/fleet-manager.ts#L11150) — Clear after-await fence / clear 等待後重驗
- [`src/fleet-manager.ts:14741`](https://github.com/songsid/AgEnD/blob/aec3af6180eff478a5b560513c5ee2909595bedb/src/fleet-manager.ts#L14741) — Selector source mapping / 選單來源對應
