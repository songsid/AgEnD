# agy 1.3.5 audit against 1.3.4 (2026-10-14, #1825)

The baseline is 1.3.4, the last audited version and the host's install; the host was not touched.

| | 1.3.4 | 1.3.5 |
|---|---|---|
| binary sha256 | `5b93565c5f04ea4f7b79d49d5c3237449bf6ce47b6779e8cf46c1fae97957c98` | `b5385638174a5e720e904f3a2678752534fb8414d10c2c302fa16daf56cbcfc9` |
| `cli_linux_x64.tar.gz` sha256 | — | `007a5a44dbaf1caea464c3d9848c63b2f69945b01a8bf8852c56c477a64374cf` |
| `--help` | — | identical but for `--mode … (accept-edits, auto, plan)`; **printed on stderr** (`../agy-help/agy-help-1.3.5.stderr.txt`, stdout is empty) |

**Static precheck** (`precheck-1.3.4-1.3.5.txt`): `PRECHECK: NONE` (hard=0, hinted=0; 16 of the 19 detector literals present in both, none missing).

## Rig

- **Isolation:** a scratch `HOME`, `unshare -rnm` (no network), and a private `tmux -L`. No real account was used.
- **Signed in without an account:**
  - A fake OAuth token (`antigravity-oauth-token`, `auth_method: consumer`).
  - An HTTPS mock bound to 127.0.0.1:443 inside the namespace answers `daily-cloudcode-pa.googleapis.com`, `www.googleapis.com` and `play.googleapis.com`, which `/etc/hosts` points at it. The hosts file is bind-mounted inside the mount namespace.
  - The mock's certificate is from a scratch CA given to agy as `SSL_CERT_FILE`.
- **What the mock answers:** `fetchAvailableModels` uses the field names decoded from the binary's own protobuf descriptors (`models{key → displayName, model, apiProvider}`, `defaultAgentModelId`, `agentModelSorts[].groups[].modelIds`). Every other call gets `{}`. `streamGenerateContent` is held for 25 s, for the busy row.
- **The catalog** has the 10 ids and labels the fleet's CLI env probe cached from the real account (`gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{…}`, `claude-sonnet-5-5-{…}`, `gpt-oss-120b-medium`, each labelled "X (Level)").
  - With it, the real binary renders the user's screenshot exactly (`model-picker.pane.txt`): four rows ("Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B (Medium)") and the Effort gauge.
  - **The naming did not change:** the server still sends one model per level, and agy's picker groups them.
- **Redaction:** the workspace path is replaced by `/work/agy-audit/proj`. The account is the mock's `audit@example.invalid`.

## Files

- `agy-models.stdout.txt` / `.stderr.txt`: `agy models` for that catalog. It is `slug<TAB>Display Name`, one row per level, on stdout; the spinner text goes to stderr. Byte-identical from 1.3.4.
- `trust-dialog.pane.txt`: the trust prompt for a model with levels (status row `Gemini 3.8 Flash · high`, right-aligned).
- `trust-dialog-no-effort-model.pane.txt`: the same for `gpt-oss-120b-medium` (status row `GPT-OSS 120B (Medium)`, no `·`).
- `trust-dialog-agend-statusline.pane.txt`: the same under AgEnD's statusLine hook, whose output (`Context 0% used`, at column 0) replaces the status row. 1.3.4 paints it the same way.
- `idle-agend-statusline.pane.txt`, `busy-generating.pane.txt` (`⣾  Generating...` above the composer, `esc to cancel` footer), `logged-out.pane.txt`: unchanged shapes from 1.3.1.
- `launch-matrix-1.3.4.txt`, `launch-matrix-1.3.5.txt`: for each `--model`/`--effort` pair, the header model, the in-pane warning, the statusline and agy's log lines. The two versions give the same results.
  - **The replacement model is random:** where agy replaces a model it cannot resolve, the replacement differs from run to run, apparently in map order. So only the warning is comparable between the files, not the model chosen.

## How agy resolves `--model` / `--effort` (both versions)

| `--model` | `--effort` | result |
|---|---|---|
| a variant slug `gemini-3.8-flash-medium` / its label `Gemini 3.8 Flash (High)` | — | that variant |
| a base slug `gemini-3.8-flash` | `high` / — | `…-high` / agy's default level |
| `gemini-3.8-flash-medium` | `medium` | that variant |
| `gemini-3.8-flash-medium` | `high` | "conflicts with --effort=high" → **another model** |
| `Gemini 3.8 Flash (High)` | any | "--effort is not supported" → **another model** |
| `gpt-oss-120b-medium` | `high` | conflict → **another model** |
| `gemini-3.8-flash` | `xhigh` | "has no "xhigh" effort" → **another model** |
| a name not offered (`Gemini 3.5 Flash (High)`, `gemini-3.5-flash-high`) | — | "not recognized" → **another model** |
| the base label `Gemini 3.8 Flash` | any | not recognized → **another model** |
| — (bare) | `high` | the current model's `high` variant |
| — (bare) | `xhigh` on a 3-level model / any on a model without levels | stays on the family / same model, with a warning |

agy never refuses and never exits over a model name. The instance starts, on another model if the name is not resolved.

## After the fix: AgEnD's own launch lines on the real 1.3.5 (same rig)

`buildCommand` ran with that catalog cached as the CLI env probe writes it (`currentModel: gemini-3.8-flash-medium`) and the real 1.3.5 binary as the binary, so its `--help` was read from stderr. Each line it printed then ran under the mock:

| config | launch line | agy runs | warning |
|---|---|---|---|
| `gemini-3.8-flash-medium` + `high` | `--model 'gemini-3.8-flash-high'` | Gemini 3.8 Flash · high | none |
| `Gemini 3.8 Flash (High)` + `low` | `--model 'gemini-3.8-flash-low'` | Gemini 3.8 Flash · low | none |
| `gpt-oss-120b-medium` + `high` | `--model 'gpt-oss-120b-medium'` (note: takes medium) | GPT-OSS 120B (Medium) | none |
| no model + `high` | `--effort high` | Gemini 3.8 Flash · high | none |
| `claude-opus-5-5-low` + `max` | `--model 'claude-opus-5-5-low'` (note: takes low, medium, high) | Claude Opus 5.5 · low | none |
| `Gemini 3.8 Flash (High)`, no effort | `--model 'Gemini 3.8 Flash (High)'` | Gemini 3.8 Flash · high | none |
