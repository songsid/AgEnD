---
type: entity
title: "Cancel Button"
tags: [feature, telegram, discord]
sources: [channel-delivery-backend-knowledge, cancel-button-business-logic]
source_version: v2.0.8
code_refs: ["src/fleet-manager.ts (sendCancelButton, clearCancelButton, deleteCancelMessage, cancelInstance)", "src/outbound-handlers.ts L144/L148"]
created: 2026-06-27
updated: 2026-06-30
---

# Cancel Button

## 概念

- 狀態：`pendingCancelMessages: Map<instanceName, {adapterId?, chatId, messageId, threadId?, timer}>`
- 每 instance 只一個 entry
- 顯示為「👀 處理中…」+ 🛑 取消 鈕
- 核心假設：一個 inbound → agent 工作 → 一次 reply 結束

## 出現條件（sendCancelButton）

| 觸發 | 為誰掛 |
|------|--------|
| Fleet topic 用戶訊息（general / instance） | 該 instance |
| Classic 用戶訊息 | 該 instance |
| Schedule 觸發 | target instance |
| 跨 instance task/query | 目標 instance |

**不會掛**: agent 自己跑 tool call / 讀寫檔。

## 消失條件

| 事件 | 結果 |
|------|------|
| Agent reply tool 成功 | clear + ✅ + reactDone |
| 按鈕或 /cancel | clear + 送中斷鍵 |
| report_result | sender 自清 |
| 同 instance 新 inbound | replace（先清舊） |
| 30min cap timer | 自我刪除（保險） |

## 中斷機制

- kiro-cli: `Ctrl+C` (tmux `C-c`)
- claude-code/codex: `Escape`

## 已知 Bug

1. **reply ≠ 結束**（最高優先）— mid-turn reply 後 agent 繼續工作 → button 已清 + ✅ 誤示完成 → 用戶無法取消
2. **無 idle 重掛** — 純 tool 執行期間無 button（idle-watch 已移除因 Thinking 誤判）
3. **DC 刪除非 100%** — 權限/rate-limit/手刪 → 偶發殘留（靠 30min cap 兜底）
4. **單 entry** — 並發請求只保留最後一顆 button
5. **跨 instance 無 react** — chat_id="" 時無 ⏳✅❌ 生命週期

## DC vs TG 差異

- **TG**: deleteMessage 直接打 API，globally addressable，幾乎不失敗
- **DC**: 需先 fetchTextChannel(threadId ?? chatId) → forum thread 也行（已修）→ 仍可能權限失敗

## 治本方向

Button 生命週期應綁「真正 idle」而非 reply tool：
- 需三態偵測（Thinking / Streaming / Idle）
- Idle 才 clear + ✅
- Reply 後仍 busy → 保留 button、react 改 🔄
- 建議併入 streaming 三態線一起做

## Sources

- [[cancel-button-business-logic]]
- [[channel-delivery-backend-knowledge]]
