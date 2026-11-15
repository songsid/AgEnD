# codex in-session model switch — rig captures (M-3175, 2026-11-15)

Captured with `scripts/manual/codex-version-audit/rig.sh` (scratch install, scratch homes, private tmux socket, the local
mock Responses API, no account) and `model-switch.mts`, which drives the production pieces the daemon uses.

| File | What it is |
|---|---|
| `0.169.0-pane-after-switches.txt` | codex 0.169.0 after `/model gpt-6-astra --reasoning=high`, `--reasoning=low`, `/model --reasoning=medium`, `/model gpt-6.1-sol`, `--reasoning=xhigh` and an unknown model (twice: before and after the first turn). Each valid line is answered `• Model changed to MODEL EFFORT for this session only`; the unknown model `■ Model 'nosuch-model' is unavailable…`. |
| `0.169.0-rollout-switch-lines.jsonl` | the same session's rollout reduced to `session_meta` (its `cli_version`), `turn_context` and every `thread_settings_applied` (model, provider, reasoning effort) — written at each switch once the rollout exists. |
| `0.163.0-pane-line-sent-as-prompt.txt` | codex 0.163.0 given `/model gpt-6.1-sol --reasoning=high`: it is a user prompt there (`› /model …`, then the mock model's `• ok`). |

Measured on 0.169.0: the next request's `model`/`reasoning.effort` were the switched ones (mock body log). `/model NAME`
without `--reasoning` gives the model's default effort (gpt-6.1-sol: low). A switch typed mid-turn is accepted too
(AgEnD switches only when idle). Codex with a custom provider does not fetch `/v1/models`: the catalog is codex's own.
