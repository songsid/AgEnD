# muse version audit (offline)

Both scripts run INSIDE a disposable container with `--network none` against `mock.py` (a fake provider; a dummy key; no account,
no network). The `docker run` line is in the header of `capture.sh`. An image whose entrypoint needs privileges can be started with
`--entrypoint sleep … infinity` and the scripts run as uid 1000 (`docker exec -u 1000`).

1. `capture.sh`: the screens AgEnD reads (start, trust, approval, errors, rate limits, sign-in). Compare with the previous audited
   version's captures.
2. **Model / effort switch (M-3180)**: `switch.sh`. AgEnD types `/model ID` (muse 1.4.6+) and `/effort LEVEL` (1.4.4+) into a running
   muse, and confirms each one from the screen (`src/backend/cli-runtime-switch.ts`, `MUSE_RUNTIME_SWITCH`). Check on the new version:
   - `switch-1-model`: `Model set to mock-alt for this session (saved model unchanged)`, and the footer row `mock-alt · <effort> · …`;
   - `switch-2-effort` / `switch-6-back`: the footer shows the new level (muse prints no answer line for `/effort`);
   - `switch-3-effort-bogus`: the refusal `◆ unsupported reasoning effort …`;
   - `mock.log`: the next turn's first `tools=['muse']` request carries the switched `model=` and `reasoning={"effort": …}`.

   If a line, the footer, or the refusal changed, update `MUSE_RUNTIME_SWITCH` and its fixtures
   (`tests/fixtures/muse-1420-model-switch/`) before the version is marked audited. If the commands themselves changed, lower nothing:
   raise `minVersion` or drop muse from `CLI_RUNTIME_SWITCH` (the fleet then restarts, as before).
