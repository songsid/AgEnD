---
section: Fixed
---
- **A configured `effort` now reaches codex, claude-code, grok and antigravity at launch (#1811).**
  - Before, only kiro-cli and muse launched with it. The others saved it and launched without: `/effort` on codex restarted the instance and changed nothing, and on claude-code, grok and antigravity it lasted until the next restart.
  - Now every launch, a resumed one included, passes it: `-c model_reasoning_effort` (codex), `--effort` (claude-code, antigravity), `--reasoning-effort` (grok).
  - A stored effort never breaks a launch. It is passed only when the installed version's `--help` lists the flag (antigravity 1.0.x has none) and the level is one that CLI takes. For codex, that is a level the model's catalog lists, because codex does not check it itself. Otherwise the instance launches on the CLI's own setting, and daemon.log and the Log tab say why (no chat notice).
  - Instances that already have `effort` set run at that level from their next restart. The runtime `/effort` is unchanged.
