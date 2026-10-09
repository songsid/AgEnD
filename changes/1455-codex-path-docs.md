---
section: Changed
---
- **Codex session resume docs: `$CODEX_HOME` takes precedence over `~/.codex`.** The two mentions of `~/.codex/state_5.sqlite` and the shared home in `docs/features.md` now read `$CODEX_HOME/state_5.sqlite` (default: `~/.codex`) and `$CODEX_HOME` (default: `~/.codex`). The code (`src/backend/codex.ts:904`) has always used `process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")`; the docs now match.
