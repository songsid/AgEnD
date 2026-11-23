# M-3522 real-app captures (#4342)

Taken at d1d78ac4b10bcc14a4f5e345d414245bd0794750, as the user approved them, and kept as they were (not retaken).
Run with `scripts/manual/go-ahead-scope-m3522/capture.mts` on the smoke fixture: scratch home, synthetic roster, no fleet
start, no CLI, account or model. Four cases: desktop light and phone dark, each in English and zh-TW. `checks.json`
records the result for every view: 0 page errors and no horizontal overflow.

- `settings-card-*.png`: Settings → the agent → Basic info, with the "Owner and routine operations" box filled with
  sample text.
- `details-claude-card-*.png`: Details → "Loaded every session" for a Claude Code agent. Its CLAUDE.md is 51 KB, over
  50 KB, so it is flagged.
- `details-codex-card-*.png`: the same card for a Codex agent. Its AGENTS.md is 40 KB, over Codex's 32 KiB cut-off.

Changes since these captures, from the review at f0c7f351 and later:
- The Codex warning reads "By default Codex reads only the first 32 KB …" (zh: 預設).
- Text already inside AGENTS.md is shown as "already in AGENTS.md" and not added to the total.
- The Codex agent captured here has no Agent instructions or operations, so no row in these images changes.
