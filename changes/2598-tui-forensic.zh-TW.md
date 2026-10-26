---
section: Fixed
---
- Peer envelope 鑑識掃描現在會讀取具有所有權與固定 session id 的 kiro TUI 紀錄，包括從 classic 帶過來的對話，不再讀取已凍結的 SQLite 副本。Legacy 維持 SQLite；V3、紀錄不完整或無法確認所有權的 TUI 仍會明確回報無法讀取。這不會開放 Log 的原始歷史（#2598）。
