---
section: Fixed
---
- **網頁：建立 team 時不會再覆蓋現有的 team，也不會儲存不存在的成員（#1692）。** dashboard 的 **新增 team** 原本直接寫入 fleet.yaml：給什麼成員名稱就存什麼，遇到同名的 team 也會直接覆蓋，原有的成員和描述就此遺失。現在它與 agent 的 `create_team` 使用相同的流程：
  - 成員必須是這個 fleet 的 instance；
  - 已存在的 team 會被拒絕（「Team already exists」），並維持原狀；
  - 像 `constructor` 這樣的名稱會被拒絕。

  如果 fleet.yaml 儲存失敗，就不會建立 team。
