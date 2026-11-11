# #2301 private replay and View evidence

All paths must be owned scratch paths. Never point a rig at a live fleet, HOME, CODEX_HOME or tmux socket. No real accounts or model requests.

## Fresh capture (optional; pinned CLI, private namespace)

Download/extract the complete public npm native package `@openai/codex@0.167.0-linux-x64` into an owned scratch prefix, with install hooks disabled. `capture.py` verifies the actual executable SHA256 before launch, requires loopback-only networking, writes fresh HOME/CODEX_HOME and a private git directory, uses a local Responses mock and shuts down only its own tmux/managed-daemon processes. It does not execute a production version probe or alter the host's installed CLI.

```
OUT=<owned output> RUN_ROOT=$PWD/.ca/<new unique scratch> \
CODEX_AUDIT_BIN=<owned complete native-package prefix>/vendor/x86_64-unknown-linux-musl/bin/codex \
unshare -Urn python3 scripts/manual/codex-pane-owner-2301/capture.py
```

The recorded fixture README lists the original fields retained and cwd normalization. No synthetic footer is substituted in recorded evidence.

## Replay (no CLI)

```
REPO=$PWD OUT=<owned receipt.json> \
unshare -Urn node --import tsx scripts/manual/codex-pane-owner-2301/replay.mts
```

Real Daemon/Outbox, actual private-tmux paste/Enter and captured frames. Startup/idle IPC is inert. `BASELINE=1 REPO=<unmodified base checkout> FIXTURES=<candidate fixtures>` proves the baseline remains uncertain; no product test timeout is changed.

## Real View shell (no CLI)

```
REPO=$PWD OUT=<owned PNG directory> PW_DIR=<prefix containing playwright-core> \
CHROME=<private Chromium executable> FONTCONFIG_FILE=<CJK-capable fontconfig> \
node --import tsx scripts/manual/codex-pane-owner-2301/view.mts
```

Uses the existing smoke fixture, scratch HOME, private tmux and the recorded frames. The actual model-probe worker boundary returns null; no vendor CLI is launched. Desktop uses normal Fit; phone uses the existing Aa control (Fit → S) so the UUID/Context detail is readable. At S, lower-value model/cwd text is horizontally scrollable. Narrow captures replay at their actual 45-column width. This changes no UI code, CSS or persisted user preferences.

R2 semantic reversals (no CLI): `REPO=$PWD OUT=<new owned output directory> python3 scripts/manual/codex-pane-owner-2301/review-mutations.py`. It compiles and runs each mutation independently and restores source in `finally`; optional `ONLY` selects comma-separated mutant names. Run only on an otherwise idle owned checkout.
