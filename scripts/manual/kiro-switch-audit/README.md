# kiro model / effort switch audit (offline)

AgEnD types `/model ID` and `/effort LEVEL` into a running kiro **TUI (v2 engine)** instance from kiro 2.30.0 and confirms each from
kiro's own session record and footer (`src/backend/cli-runtime-switch.ts`, `KIRO_RUNTIME_SWITCH`). Classic and V3 instances keep the
restart. Run this on every new kiro version as part of its audit.

No account and no network. The container is started with `--network none`, and kiro's own `KIRO_TEST_MODE` model list stands in for
the service, behind a dummy sign-in token. The TUI's command handling is kiro's own code. Start the container as `switch.sh`'s header
says, adding `--security-opt seccomp=unconfined`: Docker's default seccomp blocks `unshare`, and without it AgEnD's netless version
probe (and so `drive.mts`) cannot read the running version. The container stays unprivileged and offline.

1. `switch.sh`: captures to `out/` for the new version:
   - `1-model`: `• Model changed to <NAME>`, and the footer `kiro_default · <NAME> · <the model's default effort> · ◔ N%`;
   - `2-effort`: `• Effort set to low` (3.3.0 adds a deprecation notice for `/effort`), and the footer `· low ·`;
   - `3-effort-bogus` and `4-model-unknown`: the `•` refusals;
   - `session-1-model.json` and `session-2-effort.json`: `rts_model_state.model_info.model_id`, and
     `additional_fields.overrides.output_config.effort`.
2. `KEEP=1 switch.sh`, then `drive.mts model:claude-sonnet-4.6 effort:low model:nosuch-model` (inside the container, see its header).
   This runs the production gate, checkpoint and verdict. The expected answers are `switched`, `switched` and `mismatch`, with the
   running version shown.

If the footer, the refusals, the record fields or the commands changed, update `KIRO_RUNTIME_SWITCH` and its fixtures
(`tests/fixtures/kiro-330-model-switch/`) before the version is marked audited. If `/effort` is removed (3.3.0 deprecates it), the
effort switch stops being confirmed and falls back to the restart; move it to whatever replaces it.
