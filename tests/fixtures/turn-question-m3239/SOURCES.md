# M-3239 fixtures: a turn that ends on a question

- `claude-rehearsal.jsonl` — real Claude Code 2.1.325 transcript lines (2026-11-16, an AgEnD dev agent's beta.7 rehearsal), slimmed to
  the fields the transcript parser reads; the compaction summary is trimmed. The turn ends at 08:20:53Z on a question in its own pane, with
  no fleet message; at 09:14–09:16Z Claude compacts its context on its own (`compact_boundary`, `trigger: "auto"`, 85 s) while idle —
  the pane showed working for that time.
- `codex-question.rollout.jsonl`, `codex-messaged.rollout.jsonl` — Codex 0.169 rollout lines in the shapes of real 2026-11-16 rollouts
  (`task_started`, a `commentary` message, a code-mode `exec` call and its output, the `final_answer` message, `task_complete`). No
  Codex turn in the local rollouts ends on a question, so the answer texts and the `send_to_instance` call in the second file are
  written for the test; ids are shortened.
