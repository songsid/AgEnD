---
section: Security
---
- **zod 升到 4.6.7、body-parser 升到 2.4.0，修掉兩個高風險安全公告（#2670）。** zod 4.3.6 有 GHSA-mrhx-c7xc-m3w5。body-parser 2.3.0 經由 MCP SDK 的 express 帶進來，有 GHSA-27r3-jxmh-p828。agent 看到的工具 schema 沒有改變。一次性排程時間仍可不寫秒，例如 `2026-07-26T14:00+08:00`：zod 4.6 不接受這種寫法，所以 AgEnD 保留自己的檢查。
