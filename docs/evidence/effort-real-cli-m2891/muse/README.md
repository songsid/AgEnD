# Muse effort: actual CLI interim (M-2891)

**YES: Muse belongs in `EFFORT_BACKENDS`.** Muse Code **1.4.15-R8339.1** changes effort at runtime. A single TUI process (PID recorded in the receipt) accepted `/effort low`, then `/effort max`; its status line changed and the next main-turn `POST /responses` sent `reasoning.effort: low`, then `max`. No restart and no real account/model call.

## Isolation and provenance

Copied the installed distribution binary itself, **not its updating launcher**, into an owned prefix. Empty HOME and all XDG roots, `env -i`, private tmux socket, and `unshare -Urn` with only loopback up. No auth/config was copied. Only a dummy `META_API_KEY` was passed. The existing Muse version-audit Meta mock (`scripts/manual/muse-version-audit/mock.py` at the input git revision below) served loopback port 18800; its `/home/rh/audit` file root was replaced with the owned audit directory. Its model response was the explicit fixture `catalog-mock.json`. The mock answered model turns; it performed no commands.

Distribution binary digest: `abe0a72878c62b570c6eed6c17c5fc3c520a990ecf040511741c00092312a3d5`.
Input repository: `5316eb1e0097777e14d9ddcc0ba60af7c03e5010`.

## Commands and captures

Run the copied binary inside the isolation above:

```sh
muse --version
muse --help
muse model-profile --help
muse model-profile show muse-spark-1.3 --effort high
muse model-profile show muse-wonder-1.0 --effort max
muse --provider meta --base-url http://127.0.0.1:18800 \
  --model muse-spark-1.3 --reasoning-effort low \
  --disable-approval --trust-workspace
```

In that TUI: `/effort low` → a unique inert prompt → `/effort max` → a second unique inert prompt. Wait for the status line to show the requested level before submitting, and for the mock's **main** request to contain that unique prompt before recording it. Reminder subagents use their own effort: the last HTTP request is not necessarily the main turn. `muse-live-proof.json` records only main-turn model/reasoning, body digest and unchanged pane PID. Raw bodies stay private and are not needed in the evidence tree.

Help advertises `--reasoning-effort` (alias `--effort`): `none|minimal|low|medium|high|xhigh|max|ultra`, default high. The TUI's bare `/effort` usage advertises minimal through ultra; the tested canonical levels low/max both apply. `muse-{low,max}-verified.txt` show the status and mocked reply. `model-profile show` resolves knobs offline and explicitly says the startup default does not override the user's live `/effort`.

## Per-model limit

This is CLI/runtime-control proof, **not evidence that every vendor model accepts every tier**. The provider-populated on-disk catalog has schema-v3 `rows[].reasoning_effort_variants`; this fixture supplied model IDs without tier metadata, so its null variants do not establish a real model's support. Account-backed catalog fetch was not authorized or run. Do not convert the global CLI enum into a universal model ladder. Full Codex/Kiro/OpenCode and catalog-source findings follow on #3636.

TUI captures replace the owned absolute audit root with `/AUDIT`; request body hashes remain hashes of the original private bytes. No product files, live Fleet/config, installed binaries, or real account were changed. Rollback: stop this audit's private tmux/mock and remove its owned scratch prefix.
