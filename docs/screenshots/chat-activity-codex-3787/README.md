# Codex in the chat's activity block (#3787) — before / after

Eight pairs: desktop / phone × light / dark × English / 繁體中文. `<case>-before.png` is the upstream `release/2.3.5-alpha` at
`27de80266`; `<case>-after.png` is this change. `<case>-after-first-turn.png` scrolls to the first answered turn (the commands it
ran, two of them failed).

The thread is a Codex agent (`tool_progress: verbose`) with three messages: two answered turns (the second compacted four
times) and a third the agent is working on right now — its prompt and the steps so far, no reply yet. Before: the one
"Working…" / 「處理中…」 line is all the chat has. After: each answered turn has its block above the reply it produced, and the
live turn has its block with the steps so far. In the pictures every block is opened.

## What it shows, and what it reuses

Nothing new on the page: the block, its rows and its styles are the ones Claude Code, Antigravity and Grok already use.

- the block: `ActivityBlock` / `mountActivity` in `src/ui/chat-activity.js` (the `details.act-block` with "Tool history · used N tools",
  the live line "Run echo done · 1 tool · 52 s")
- which reply a step belongs to: `groupSteps` / `composeRows` in `src/ui/chat-activity-groups.js` (by the id the `reply` call
  returned: `level: "id"` for all three turns)
- a step's row: `LogRow` in `src/ui/log-row.js` (the Run / Read / Said verbs, `failed · exit 127`, the command's output)

The change is on the server: `src/log-service.ts` no longer answers `supported: false` for Codex, and `src/log-steps.ts`
reads Codex's rollout the way it is really written.

## How they were made

The real production dashboard in Chromium over the smoke fixture, with `tests/fixtures/chat-activity-3787` as the instance's
transcript (its clock moved to now) and chat ledger. The same script, once against a checkout without the change:

```
REPO=<checkout> PW_DIR=<dir with node_modules/playwright-core> OUT=<dir> STAGE=before|after MATRIX=full \
  npx tsx scripts/manual/smoke/smoke-chat-activity-codex-3787.mts
```

No fleet start, no CLI, no tmux, no network but the fixture's own loopback listeners. The fixture is a redacted capture; the
wording of the agent's messages is from a test run, not a person.
