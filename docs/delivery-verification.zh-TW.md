# 驗證轉交訊息與使用者授權

Agent 的摘要可能省略或改變使用者授權的內容。過去 `delivery_status` 只讓寄件者和收件者讀取，因此第三個 instance 即使拿到原始 ID，也無法驗證。現在明確轉交可以授予原始列的唯讀權限。

```json
{"instance_name":"worker","message":"先核對原始授權再操作","forwards":["hmsg-<receipt UUID>"]}
```

`send_to_instance`、`delegate_task` 接受最多 16 個不重複的 `forwards` ID。寄件者必須能讀到每一列，且該列必須已送達。新訊息與讀取授權一起提交。只在文字提到 ID 不會授權；再轉交一次也必須明列 `forwards`。收件者不會取得其他列、相同 correlation 的其他訊息或隱藏分頁游標。重試已受理的操作不能增加／替換引用，或改變內容、收件者、session 與要求的模式。轉交操作以經驗證的寄件者和 operation ID 綁定，不受實際投遞模式影響；前一則排隊訊息出現或消失時，相同重試仍沿用第一次受理的模式。最小操作記錄不隨通知清理而消失；原受理列已清除時，重試會拒絕，不建立新授權。

**ID 必須放在 `forwards`，不是寫在文字裡。** agent 若把 verification ID 寫進訊息內文，收件者的 `delivery_status` 會回「Delivery not found」。升級到 beta.7 後實際發生過一次（#1780）。跨 AgEnD 升級續用的 Claude Code session 會沿用先前載入的工具 schema，重新載入（`ToolSearch`）或伺服器的新工具清單都不會換掉它，所以它的 `send_to_instance` 可能沒有 `forwards`。照樣傳這個參數即可：client 以當下的 schema 檢查呼叫，AgEnD 伺服器也會接受。每次升級，AgEnD 會用 what's-new 通知告訴執行中的 instance 有哪些新參數，每個通知只發一次。Codex、Kiro 和 Muse 續用 session 時都會重新取得工具清單。

## 原始使用者收據

新的 Discord、Telegram 事件會由可信任的 SDK 入口記錄實際 adapter、使用者 ID、username 與平台訊息 ID。引用文字、bot／系統訊息、agent 文字和歷史轉交不會補上 human origin。Discord 收據只接受非 system 的 Default (0) 或 Reply (19) 事件；建立主題的標題及不支援／未知的 type 不具有使用者授權。Discord 原生轉寄的原始內容只記外層使用者自己輸入的文字；引用者的文字不等於這位使用者的授權。

目標收到另外的 `[agend-human-id:hmsg-…]` 與 `verification_id`。平台 `message_id` 仍供回覆和反應使用。查原始使用者收據時使用驗證 ID：

```json
{"message_id":"hmsg-<receipt UUID>"}
```

結果含原始 `content`、`origin`、`content_sha256`、`wire_content_sha256`、`proof_kind` 與 `delivered_at`。原文在附件處理、Classic 聊天脈絡加入與 Web／slash 操作參數去除首尾空白前保存；wire hash 則涵蓋實際格式化、清理後的投遞位元組。明確授權的收件者讀到同一份原文，不是轉交摘要。其他查詢形式仍不顯示內容。

- 平台訊息：`origin.platform`、`adapter_id`、`user_id` 分別代表平台、bot 連線與使用者。顯示名稱不是身份 ID。
- 按鈕／slash 操作：記錄點擊或 interaction，已知時附其 anchor；`platform_message_id` 是 null，因為 bot 回覆不是人類撰寫的訊息。按鈕原文是使用者看見的 label，隱藏 value 只在 wire 內容中。
- Web：platform 是 `web`，平台使用者／adapter／訊息 ID 為 null，不宣稱已驗證 Telegram 或 Discord 身份。

不可逆操作前，同時核對**轉交 agent 的訊息**及原始使用者收據：必須是 delivered 且有支援的 owned proof，平台／adapter／actor 必須是對該資源有權授權的人，原文也必須明列確切操作和資源。收據證明 CLI 受理，不代表任何操作都有權限；仍要另外核對真實 ref／資源。

## 正向證據與限制

| 模式 | 可以成立的使用者投遞證據 |
|---|---|
| Idle／原生 queue | 本次新收據 ID 出現在可讀輸入區以外，且觀察屬於目前的 owner。 |
| Structural steer | Enter 前的新輸入區持有本次 ID；一次 Enter 後，同一個目前 owner 的輸入區在支援的 steer／queue／idle 模式確定為空，沒有 dialog，且未超時。 |
| `/raw` | 不提供正向授權證據，因為貼上的原始位元組沒有收據 ID。 |

每份證據核對收據 ID、模式、wire hash，並重新驗證 Daemon 物件／boot、launch tuple、tmux owner、lifecycle 與 delivery epoch。只有輸出變化、草稿消失、普通 success、不可讀／未知輸入區或不可讀 transcript 都維持 uncertain。不新增 paste、Enter、transcript 輪詢或重送政策。原生受理不會填入 `consumed_at`／`consumed_via`。

`Delivery not found` 也可能是隱藏、過期或不存在。不能由此推定授權或重送；請要求明確轉交或新的授權。queued／uncertain 使用者收據不能作為授權轉交。它們只保存證據，不會排程投遞或重送；新 process 將舊的未完成收據標為 uncertain。保存期限會一起刪除原始證據與授權，但只刪掉轉交訊息不會取消原文的讀取授權。

CLI 模式的 `agend-agent send`／`delegate` 支援可重複的 `--forward`，查詢用 `agend-agent delivery-status --message-id <verification_id>`。

同 uid 且能使用 shell 的 agent 並未互相隔離。這些授權保護的是經驗證的工具入口，不是共用 OS 使用者的惡意 process。互不信任時須用不同 OS user／container。回滾程式後，舊版會以寄件者／收件者規則隱藏轉交讀取；新增證據表可留在磁碟。回滾不要刪除或重播 outbox。

[English](delivery-verification.md)
