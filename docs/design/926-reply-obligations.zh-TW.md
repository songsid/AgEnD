# #926：要求回覆的訊息，回覆義務要被追蹤（reply obligation）

狀態：**已實作**（CHANGELOG 2.1.7，#926 已關閉）。sweep 在 `FleetManager.sweepReplyObligations()`（`src/fleet-manager.ts`），obligation 存在 outbox 的 `reply_obligations` 表（`src/delivery-outbox.ts`）。逾時預設採 15 分鐘（`DEFAULT_REPLY_OVERDUE_MINUTES`），下文已依程式更正。
相關：#926、#929 durable outbox、#910 submit proof、#856 可驗證 message_id。

## 1. 2026-09-24 那兩次到底發生什麼（實證，唯讀）

兩次都**不是傳輸層丟訊息**。**需要回的那則訊息根本從來沒被送出去**，所以不存在「投遞失敗」可以回報。

**#924（issue 引的 `cid-1790244237584-i5334l` 其實是這張單）**

- 證據：reviewer 的 codex rollout（`rollout-2026-09-24T18-06-29-…`）。
- 18:06 收到委派 → claim task → 交給 codex 子代理 → 18:09 `task_complete`。
- 最後的審查結論（「Static audit found two blocking integration gaps…」）只是**這一輪的最終文字**，整份 rollout 裡**沒有**任何一次 `report_result` 或 `send_to_instance` 帶這個 cid。
- 文字留在 pane 上，leader 永遠收不到。

**#925（issue 標題講的那張）**

- 21:09:53 leader 委派 #925。
- **21:25:51 整個 fleet 重啟**（所有 instance 重新 Starting）。
- reviewer 做到一半的那一輪被 Strategy A 砍掉；codex resume 回來後，那一輪不會自己接續，reviewer 就停在 idle。
- 直到 23:02 leader 主動追問，23:03 才收到 REQUEST_CHANGES。
- 這也符合 reviewer 自己的說法：「上一輪未完成 verdict 投遞」。

**對照：#910 和 #929 已經涵蓋「真的有送出去」的那一段**

- 只要 `report_result` 真的被呼叫，#929 會先把 row commit 進 durable outbox 才回 ack。
- 之後照 idle-gated 投遞；failed / uncertain / TTL 到期時，會以 `insertFailureNotice` 通知**送方**。
- #910 則修掉了 submit-proof 的 false-negative。
- 所以「leader 在兩個 turn 之間收到」「queue 或 ack 有空隙」這類傳輸面的縫，現在都有 durable row 加上 terminal 通知兜住。
- **剩下的縫只有一種：該回的回覆從來沒產生。** 常見情況：
  - 用 terminal 文字回，沒有呼叫工具。
  - 那一輪被重啟或 crash 打斷。
  - model 忘了回。
- 這些情況下，fleet 裡沒有任何東西記得「X 欠 Y 一個回覆」。

## 2. 設計：durable 的 reply obligation

### 2.1 什麼時候開、什麼時候關

- **開**：一筆 durable row 帶有 `meta.requires_reply === "true"`（`delegate_task` 或 `request_information` 會自動帶，`send_to_instance` 可以自己設），而且它進入 `delivered` 狀態時，開一筆 obligation：`(correlation_id, requester=source, owner=target, request_delivery_id, opened_at)`。
  - 只在 `delivered` 時開。`uncertain` 的情況，#929 已經會通知送方，不再重複開 obligation。
  - `broadcast` 第一版不開，因為一對多時「誰欠誰」語意不清。
- **關**：只要有一筆 **target → requester、帶同一個 correlation_id** 的 durable row 被 admit，就關閉。`report_result` 或 `send_to_instance` 都算。
  - 關在 admission 這一步就好，不用等投遞完成：之後送不到的話，#929 本來就會通知。
- **不關**：requester 再追問一次（requester → target、同一個 cid），不會關掉 obligation；它會刷新 `last_asked_at`，並把 nudge 重新開放一次。

### 2.2 儲存

- 在 outbox DB 新增一張表 `reply_obligations`：
  - 欄位：`correlation_id, requester_instance, owner_instance, request_delivery_id, opened_at, last_asked_at, state, nudged_at, overdue_notified_at, answered_at, answered_delivery_id`
  - primary key：`(correlation_id, requester_instance, owner_instance)`
  - `state` 的值：`open | answered | cancelled`
- 放在 DB 裡，所以**重啟不會遺失**。#925 就是被重啟弄丟的。
- 開與關，都跟觸發它的 row 的狀態轉換放在同一個 transaction 裡。

### 2.3 兩道安全網

1. **提醒 owner（解 #924 那種）**：
   - 觸發條件：owner daemon 發出 `instance_state`，從 working 轉成 idle（代表這一輪結束了）；它身上有 `open` 且還沒提醒過的 obligation；而且距離 `opened_at` 已超過 60 秒的寬限（避免一收到就回的正常情況誤觸）。
   - 動作：admit 一筆系統通知給 owner：
     `[system:reply-pending] Your turn ended without answering <requester> (correlation_id X, asked HH:MM). Send your conclusion with report_result now — text you write in the terminal does not reach them.`
   - 每筆 obligation 只提醒一次；requester 再追問時會重新開放一次提醒。
   - **重啟情境（解 #925 那種）**：`onDaemonReady` 時，如果 owner 身上還有 open obligation，就提醒一次，文字改為「A restart interrupted your work on correlation_id X from <requester>; resume and report with report_result.」
2. **通知 requester（leader／coordinator 的 poll-on-timeout 安全網）**：
   - 觸發條件：obligation 仍是 `open`，owner 目前**是 idle**（owner 還在工作時不打擾，長時間的審查是正常的），而且距離 `max(opened_at, nudged_at, last_asked_at)` 已超過 `reply_overdue_minutes`（預設 15 分鐘，見 `src/fleet-manager.ts` 的 `DEFAULT_REPLY_OVERDUE_MINUTES`；設 0 表示關閉）。
   - 動作：通知 requester 一次：
     `[system:reply-overdue] <owner> has not answered correlation_id X (asked HH:MM, reminded HH:MM, idle since HH:MM). Check with describe_instance / delivery_status, or ask again.`
   - 實作：fleet 每 30 秒掃一次（`REPLY_OBLIGATION_SWEEP_MS = 30_000`，`src/fleet-manager.ts`），搭 outbox 既有的 pump timer。
   - 這條規則的目的：coordinator 不再無限期 idle 等待；超時就有人主動告訴它。

### 2.4 查得到

- `delivery_status`（依 correlation_id 查）的每筆結果多一個欄位 `reply_obligation: { state, opened_at, nudged_at, overdue_notified_at }`，授權沿用 #982：只有 source 或 target 看得到。
- operator 用 `agend delivery show --correlation-id` 也看得到。

## 3. 不做什麼

- 不自動重送、不自動重新委派。是否重問、改派給誰，由 requester 決定。
- 不嘗試判斷 owner 的 terminal 文字「算不算回覆」：只有真的經過工具送出的訊息才算數，這正是 #924 的教訓。
- 使用者／平台訊息（`[user:…]`）不在範圍內。

## 4. 測試（實作時，全部用真 outbox 和真 Daemon）

- **開關**：delegate 送達後 → obligation 開啟；owner 以同一個 cid 呼叫 `report_result` → admission 時關閉；requester 再追問 → 仍維持 open，並刷新提醒；broadcast 不開。
- **#924 情境**：真 Daemon 的 working → idle、沒有回覆 → owner 收到一次 `reply-pending`，第二次 idle 不會再發；60 秒內就轉 idle 則不發。
- **#925 情境**：obligation 開著時整個 process 被 SIGKILL，重啟後 `onDaemonReady` → 提醒一次，而且 obligation 在 DB 裡還在。
- **overdue**：owner idle 超過期限 → requester 收到一次；owner 仍在 working → 不發；設為 0 → 關閉。
- **mutation**（都必須轉紅）：
  - 不開 obligation
  - 在 delivered 之前就開
  - 用錯方向關（requester → owner 也關閉）
  - 不用 cid 比對就關
  - 60 秒寬限拿掉
  - 同一筆提醒兩次
  - 重啟後不提醒
  - owner 在忙也通知 requester
  - overdue 通知發兩次
  - obligation 不寫進 DB（改存記憶體）

## 5. 相容性與 rollback

- 新增一張表和系統通知兩種新文字，是純新增。
- `reply_overdue_minutes: 0` 可以關掉 requester 通知。
- revert 即可回到原狀，不需要 down-migration。

## 6. 待 leader 決定

1. `reply_overdue_minutes` 預設值：我建議 20 分鐘（實作採 15 分鐘）。你那邊的 re-poke 經驗，多久合理？
2. 提醒 owner 的寬限：我建議 60 秒。
3. `broadcast` 是否要逐一 target 開 obligation？我建議第一版不要。
4. 通知 requester 時，要不要**同時**在 General 或該 instance 的 topic 發一則給人看？我建議先只通知 requester（agent）。
