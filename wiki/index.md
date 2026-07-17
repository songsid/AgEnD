# Wiki Index

Entry point for the AgEnD knowledge base. One line per page.

## Sources

- [[changelog-v2.0.2]] — v2.0.2 release: multi-channel, Rich Message receive, memory layering
- [[changelog-v2.0.3]] — v2.0.3 beta: instance warmup, fleet command parity, /compact
- [[changelog-v2.0.4]] — v2.0.4 patch: audio/video attachments fix; v2.0.5-beta.1: chat-log timezone
- [[changelog-v2.0.5]] — v2.0.5: agend doctor mcp, decision filtering, 12 bug fixes (hang detector, background session)
- [[auto-pause-design]] — Cost Guard auto-pause mechanism and v2.1.0 design
- [[auto-pause-v2.1.0-design]] — v2.1.0 Auto-Pause 完整設計（狀態機、wake 策略、guardrails、架構）
- [[model-validation-discovery]] — Model 驗證機制缺陷 + 各 CLI dry-run 調查（2026-06-26）
- [[channel-delivery-backend-knowledge]] — dev2 累積的 Channel/Delivery/Backend 工程知識（12 項坑點）
- [[multi-bot-identity-design]] — 同 Channel 多 Bot/Agent 設計（v2.1.0 planned）
- [[multi-bot-persona-ux]] — Quickstart persona 流程 + 分 token slash commands
- [[cancel-button-business-logic]] — Cancel Button 完整業務邏輯（觸發/消失/場景/bug/治本）
- [[web-view-design]] — Web View (/view) 設計（terminal stream + profiles + 認證分離）
- [[v2.0.11-features]] — v2.0.11 batch: Settings page, Config Validator, Multi-Bot, Quickstart Persona
- [[context-detection-research]] — Context % 偵測研究（agy/codex 方案 + 競品 + v2.1 設計點）
- [[roadmap-2026-06-20]] — 版本規劃: v2.0.3 release + v2.1.0 Auto-Pause + 未來方向
- [[streaming-cancel-design]] — v2.1.0 Streaming + Cancel 設計（TG Rich Message Draft / DC poll）
- [[dev-workflow]] — 團隊開發流程（角色、PR flow、release、review 規範）
- [[cicd-and-docs-workflow]] — CI/CD publish workflow + release 文件更新流程

## Entities

- [[cost-guard]] — Per-instance daily spending limit with auto-pause
- [[fleet-commands]] — Slash commands for fleet management (TG + DC)
- [[instance-warmup]] — Auto-trigger context loading after spawn
- [[rich-messages]] — Telegram Rich Message send/receive (Bot API 10.1)
- [[roadmap]] — 版本規劃與 Auto-Pause v2.1.0 設計
- [[streaming]] — 即時 streaming 顯示 + /cancel（v2.1.0）
- [[web-view]] — 唯讀 Web View (/view) — terminal stream + instance profiles
- [[settings-page]] — /settings 結構化 config 編輯（form + YAML 雙向同步）
- [[config-validator]] — Config 驗證（CLI + MCP tool + Settings page）
- [[model-validation]] — Model 名稱驗證機制 + 各 backend dry-run 能力
- [[cancel-button]] — /cancel 中斷生成 + 完整業務邏輯（bug 清單 + 治本方向）

## Concepts

- [[classic-reply-routing]] — Classic instance 回覆路由（TG/DC 共用層）
- [[command-permissions]] — 指令權限架構（fleet vs classic admin）
- [[channel-delivery-pitfalls]] — Channel/Delivery 開發陷阱（12 項必讀坑點）
- [[crash-recovery]] — Context management evolution and crash recovery design
- [[dev-workflow]] — 開發流程（PR flow、release、review 規範、通訊協議）
- [[cicd]] — GitHub Actions publish workflow + 版本通道 + 文件更新流程
- [[memory-layering]] — Three-tier memory: Decision → soul.md → skill
- [[multi-channel-architecture]] — Multi-platform support with per-adapter Generals
- [[multi-bot-persona]] — 同 Channel 多 Bot/Agent 設計（config、路由、quickstart UX）

## Synthesis

- [[version-overview-user]] — v0.0.16 ~ v2.0.4 使用者版更新總覽
- [[fleet-skills-design]] — Fleet Skills / 自訂快捷指令（構想，v2.1+）
