# Codex 0.170.0 to 0.171.0 audit

**Outcome: no production detector change needed.** 0.171 turns the workspace TUI on by default (`tui_workspace` is
now Stable and `default_enabled: true`). AgEnD always launches codex with `--no-alt-screen`, and the workspace still
requires an owned transcript, which that flag rules out, so production panes keep the terminal layout. Every
precheck string on a detector surface already exists in 0.170, or never reaches the TUI.

## Live method

Every installed package (`@openai/codex` and its six platform packages) matches the npm registry's `dist.integrity`,
for both versions. The Linux x64 binaries ran in user and network namespaces with loopback only (`netns.sh`: `lo` is
raised as mapped root, then the run maps back to the caller's uid). Each run first checked that the outside network
was unreachable. Homes were fresh, short and audit-owned; tmux sockets were private. No real account, provider,
Windows process or user pane was used. Production `writeConfig` and `buildCommand` generated the ordinary launches,
and every turn went to the rig's local mock.

- `pass1.sh` and `pass2.sh`: 25 phases each. They cover fresh start and resume, busy, compaction, quota and workspace
  limits, provider errors, trust and the rate-limit picker: 107 stored frames for 0.170, 117 for 0.171.
- `status-layout.sh`: 24 states each (44 plain changed frames and 24 ANSI frames per version):
  - two status orders at 150/80/50 columns;
  - the requested workspace with the production flag;
  - the lab owned layout with sidebar focus at 150/110/95 columns.
- `signin.sh`: the empty-profile sign-in menu and the secondary method menu. No account method was chosen.
- Real-CLI e2e (`AGEND_CODEX_E2E=1`, loopback mock, inert auth file): **7/7 on each version**. The version gates in
  `codex-exact-cwd-resume-e2e` and `codex-status-line-e2e` now include 0.171.
- Rollback: one mock turn on 0.171, then production exact-session resume of that home on 0.170. It reached a
  ready, deliverable composer with the recorded question visible (`rollback-from-01710`).
- In-session model switch (dev-branch seam): four cases before and after one mock turn on each version, 16 outcomes,
  identical on both versions and to the 0.170 audit's record. The last mock request carries the switched model and
  effort (`model-switch.json`).

## What the frames establish

- Each of the 52 captured scenarios (25 baseline, 24 status, 3 sign-in) ends in the same production reading on both versions:
  - ready, busy and deliverable;
  - stable idle and redraw;
  - the resume-loading transient;
  - runtime and startup dialogs;
  - the error patterns.
- Some in-between frames differ only in capture timing. For example, a dialog is still visible at the start of its
  Escape phase, and a resize leaves one blank frame.
- Production status layouts at 150/80/50 columns, and the workspace requested together with the production flag,
  stay ready and deliverable on 0.171 with its workspace default on. The lab owned layout stays held, as in 0.170.
- Trust, workspace-limit and rate-limit dialogs keep their actions; sign-in is held for a person.

`codex-0171-audit.test.ts` pins these readings for the 107 normalized frames (8 ANSI). It also checks that the
precheck's strings match no codex error pattern. Normalization rewrote paths to `/audit/…` and UUIDs to synthetic ones,
and stripped OSC sequences; it changed no frame's reading. `sources.json` maps each fixture to its capture and SHA-256.

## Source checks (`rust-v0.170.0` → `rust-v0.171.0`)

- `tui_workspace`: `Stage::UnderDevelopment, default_enabled: false` → `Stage::Stable, default_enabled: true`.
  `LocalSettings::workspace_enabled` still requires `transcript_mode.is_owned()`. `TranscriptMode::resolve` is owned
  only with the alternate screen, and `determine_alt_screen_mode` returns false whenever `--no-alt-screen` is passed.
  None of these changed.
- Precheck strings:
  - `Press R to refresh Analytics.`, the rate-limit reset credit timeout, `usage limit (omitted when unavailable)`
    (the status-line item description) and `Yes, and allow these permissions for this session` are all present in
    both releases;
  - `rate limit exceeded; sleeping.` is not in codex's own source: it is a library log string present in both
    binaries.
- Approval overlay: the choices are unchanged. An MCP request's server label may now read
  `<server> (environment <id>)`; AgEnD does not read that line.
- Unchanged: `onboarding/trust_directory.rs`, `onboarding/auth.rs`, `key_hint.rs`, `update_prompt.rs`.
- State: migrations 63 (`session_model_ids` table) and 64 (`threads` listing indexes) are added. No `threads` column
  changes, so AgEnD's `threads` queries are unaffected, and the rollback resume above ran on a migrated home.

## Rig note

A new network namespace starts with `lo` down. Without raising it, codex never reaches the mock: every turn shows
`Reconnecting... waiting for network` and the pane looks plausible, but no error frame is real. `netns.sh` raises
`lo` and checks it. A first capture attempt here ran without it and was discarded.

## Validation and limits

The fixture suite fails when a 0.171 frame's reading diverges (a swapped fixture fails its comparison case). This
audit proves Linux x64 rendering and local mock behavior. It makes no real-account, cloud-service or Windows-runtime
claim. Mark the release audited after the main and dev changes merge.
