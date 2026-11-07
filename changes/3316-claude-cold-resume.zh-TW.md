---
section: Fixed
---

- Claude Code Agent：Claude Code 在恢復一段很長、閒置已久的對話時會跳出「Resume this conversation?」提示；當提示附帶「之後可以查回這段對話」的說明時，以及 Claude Code 2.1.319 多了「Resume from summary」選項時，AgEnD 現在會再次自動回答（按 Escape：保留完整對話）。之前 Agent 會停在「需要你處理」等人回應。AgEnD 仍不會自行開新對話或改用摘要；其他樣式的提示一樣留給人處理。(#3316)
