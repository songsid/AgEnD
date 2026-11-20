---
title: '連接 Claude Code：訂閱登入、setup-token 或 API key'
description: 選擇 Claude Code 帳號設定檔的登入方式，了解計費，以及如何替換或移除保存的憑證。
---

本頁適用於**AgEnD 2.4.0-beta.16 及後續版本**。較早版本可能沒有這些控制項。

不支援由組織管理的 Claude 設定。

## 選擇方式

| 方式 | 從哪裡取得 | 計費與適用情境 |
| --- | --- | --- |
| 訂閱帳號登入 | Claude 官方登入頁 | 一般 Claude 訂閱的首選，仍受方案額度限制。 |
| 貼上 setup-token | 自己電腦上的官方 Claude Code CLI | Claude Code 的訂閱憑證，仍受訂閱限制；適合先在另一台電腦取得憑證。 |
| 貼上 Anthropic API key | Anthropic Console | API 另外計費，不使用 Claude 訂閱額度；選用前先確認 API 帳單。 |

可用方式取決於你的方案與組織。請參閱 [Claude Code 官方驗證說明](https://code.claude.com/docs/en/authentication)。

<span id="subscription"></span>
## 訂閱帳號登入

開啟 **設定 → AI 帳號與金鑰 → 帳號 → Claude Code**，選「**訂閱帳號登入**」，到 Claude 官方網站完成登入。不要把網站密碼貼進 AgEnD。

<span id="oauth"></span>
## 取得 setup-token

在執行 AgEnD 的電腦開啟本機儀表板，驗證管理員身分後，選「**貼上 setup-token → 幫我取得 Token**」。AgEnD 會開啟私密登入工作階段。按「**開啟登入頁面**」，在 Claude 網站登入；若畫面要求，將「**授權碼**」貼回 AgEnD。Token 會直接加密保存，不會顯示出來。流程在 10 分鐘後逾時，可重試或改為貼上 Token。儲存不會發出模型請求。

若要自行取得 Token：

1. 在**你自己的電腦**安裝或開啟官方 Claude Code CLI，執行：

   ```sh
   claude setup-token
   ```

2. 依官方流程登入，私下複製產生的 token。指令會顯示 token，不會替你保存。
3. 在執行 AgEnD 的電腦開啟**本機儀表板**，以已驗證管理員身分，在 Claude Code 帳號控制項選「**貼上 setup-token**」，貼入並按「**儲存憑證**」。

公開儀表板連結不能保存憑證。不要把 token 傳到聊天或放進截圖。上面的指令是「**幫我取得 Token**」以外的手動方式。請參閱[官方 CLI 說明](https://code.claude.com/docs/en/cli-reference)。

<span id="api"></span>
## 取得 API key

1. 開啟 [Anthropic Console → API keys](https://platform.claude.com/settings/keys)，選擇要使用的 workspace，建立 key 並私下複製。
2. 確認計費方式，設定帳號可用的組織或 workspace 支出控制。不要把它當成每支 key 都能獨立設定的上限。預設 workspace 無法另外設定支出上限；詳見 [workspace 支出設定](https://support.claude.com/en/articles/9796807-create-and-manage-workspaces-in-the-claude-console)。
3. 回到 AgEnD 本機儀表板，以已驗證管理員身分選「**貼上 Anthropic API key**」，貼入並按「**儲存憑證**」。

API 費用與訂閱分開計算。AgEnD 不會替你設定 Anthropic 的預算。

## 已儲存不等於已驗證

「**已儲存 · 尚未驗證**」表示已檢查格式並保存憑證。**儲存時不會呼叫模型**，也不會發出付費模型請求。單憑儲存不能確認 Anthropic 接受這份憑證，已儲存的狀態仍為尚未驗證。正常使用若發生驗證失敗，請檢查或替換憑證。貼入憑證不會提供訂閱額度表，也不會猜測剩餘餘額。

## 誰可能取得憑證？

AgEnD 會加密保存的副本。但以**同一個電腦使用者**身分執行的 Agent，仍可能在使用時取得它。加密無法把它與那個 Agent 隔離。

API key 透過憑證 helper 提供給 Claude Code；setup-token 放在 Claude 子行程的環境變數。兩者都不能隔離以同一個電腦使用者身分執行的行程。

## 替換、移除與撤銷

- **替換**：保留帳號設定檔名稱、指派與對話。確認受影響的 Agent 與閒置時重新啟動的安排。格式或儲存失敗時，會保留舊憑證。
- **移除**：先移走或停止使用它的 Agent，再刪除 AgEnD 保存的憑證。保留帳號設定檔與對話，且不會退回使用已移除的憑證。這與刪除帳號設定檔不同。
- **到 Anthropic 撤銷**：移除 AgEnD 的副本，不會讓其他副本失效。API key 可到 Anthropic Console 刪除以撤銷，詳見 [API key 安全說明](https://support.claude.com/en/articles/9767949-api-key-best-practices-keep-your-keys-safe-and-secure)。setup-token 請依 Anthropic 當時的帳號／session 說明處理，或洽[官方支援](https://support.claude.com/)。本頁不承諾有能單獨撤銷一支 setup-token 的控制項。

## 疑難排解

無法儲存時，請在執行 AgEnD 的電腦開啟儀表板，並驗證管理員身分。驗證失敗時，檢查憑證類型、效期與供應商權限，必要時替換。網路失敗不會刪除保存的憑證。帳號設定檔選擇與切換請見[網頁指南](/AgEnD/zh-tw/docs/web-guide/)。
