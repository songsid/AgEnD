---
section: Added
---
- **團隊決策（#3420）。** `post_decision` 新增 `scope: "team"`。團隊決策會送到該團隊（fleet.yaml 的 `teams`）的每位成員，不論成員在哪個目錄工作：在其他目錄、worktree 或工作區的隊友也看得到。其他團隊看不到。
  - Agent 屬於某個團隊時，預設就是團隊範圍。屬於多個團隊時要用 `team` 指定一個。不屬於任何團隊的 Agent 仍預設為 `project`（只限這個目錄）。
  - 成員資格在列出決策時和每次啟動時讀取，所以加入或離開團隊會立即生效，不必重新發布。
  - Agent 的 Active Decisions 現在包含整個 Fleet 的、它所屬團隊的，以及它自己目錄的決策。
  - Fleet 範圍只用於每個團隊都遵守的規則。工具說明、delegation 與 concepts 指南不再建議把團隊慣例發布到整個 Fleet。
  - 退回舊版時，團隊決策會被隱藏，不會變成所有人都看得到。
