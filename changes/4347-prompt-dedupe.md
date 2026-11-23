---
section: Changed
---
- Agents start each session with about 1,000 fewer tokens of instructions (about 1,200 in CLI mode): each rule is stated once, Active Decisions list titles only (agents read a rule's text when they need it), and the detailed web-chat receipt checks live in the cross-instance-messaging skill, which agents load before a go-ahead action. The rules themselves are unchanged (#4347).
