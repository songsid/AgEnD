---
section: Added
---
- **A Log tab for each instance shows its work step by step (#1218).**
  - The new 「紀錄」/"Log" tab sits between View and Details. It shows each prompt, the agent's replies (never its thinking), every tool call with its arguments and result, errors, where each turn ended, and fleet events such as a crash, a restart or a waiting prompt.
  - Steps are read on demand from the agent's own transcript when the tab is open, and update live while someone is watching. Secret values (keys, tokens, passwords, long random strings) are masked; long text is cut, with "Show more".
  - It is off by default (`web.log_tab`). Off, it does no work at all. A fleet admin turns it on in Settings → Web, and that change is confirmed like any access change. Once on, it is also available over the public link.
  - Supported: claude-code and codex now. For other backends the tab shows fleet events only.
