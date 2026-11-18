# Codex 0.169.0 to 0.170.0 audit

**Outcome: no production detector change needed.** The extra unfocused status rows are real, but AgEnD's production
`--no-alt-screen` disables the owned transcript required by `tui_workspace`. The audit separately enables that lab
mode: the unfocused composer is a bare `›`, not an editable placeholder, and existing input guards hold it.

## Live method

Both exact Linux x64 release packages match the npm registry SHA-512 values. Their binaries ran in `unshare -rn` namespaces with loopback only, fresh short homes and private
tmux sockets using `-f /dev/null`. No real account, provider, Windows process or user pane was used. Production
`writeConfig` and `buildCommand` generated the ordinary launches. Mock questions and answers contain only audit text.

- `pass1.sh` and `pass2.sh`: 25 phases each, including fresh/resume, busy, compaction, quota/workspace limits, provider
  errors, trust and the rate-limit picker. There are 161 stored frames for 0.169 and 154 for 0.170. The 0.170 quit
  phase stored no changed frame; the following real resume succeeded.
- `status-layout.sh`: 24 states each, two requested status orders at 150/80/50 columns, then workspace main/sidebar
  focus at 150/110/95. Production canonicalizes the private status order to put session id and Context first. The
  explicit lab alone removes `--no-alt-screen`; F6 focuses the sidebar and F7 returns to the main composer. At fewer
  than 100 columns the sidebar replaces the main area. There are 42/43 plain changed frames plus 24 ANSI frames each.
- `signin.sh`: empty-profile sign-in menu and the secondary method menu. A positive selected-row check precedes Enter
  on “Sign in another way”. No account method, code or token was entered, and no browser was opened.
- Existing `AGEND_CODEX_E2E=1` cases: **7/7 on each version**, using a fixed loopback mock, an inert auth fixture and
  short audit-owned roots. This covers exact-worktree resume, private runtime-directory controls and the configured
  status line. Version gates explicitly include 0.169 and 0.170. Mock mode refuses an implicit operator-login fallback.
- Rollback: one mock turn on 0.170, followed by production exact-session resume of that same owned home on 0.169,
  reached a ready/deliverable composer with the recorded question intact. `rollback.sh` preserves this check.
- Alpha's existing model-switch helper: four cases before and after one mock turn on each version, **16 outcomes**.
  Model+effort, effort-only and model-only changes confirm on the pane before a rollout, then through
  `thread_settings_applied`; an unknown model is refused on the pane in both stages. A subsequent mock request uses
  the confirmed model and effort. Main has no in-session switch implementation; these checks cover the alpha seam.

The baseline wrapper was edited while running and reported an EOF after both versions' passes had completed. The
saved scenario ledger was validated independently and the private servers were stopped; no baseline was repeated.

## What the frames establish

- Ordinary and narrow production status lines remain ready and deliverable. The UUID/Context prefix survives before
  less important fields; a truncated percentage remains unavailable rather than being invented.
- Busy and resume-loading keep their independent guards. Error-history text is not an ordinary new error event.
- The optional owned layout is held by the strict footer proof. Unfocused/sidebar-only frames also fail the stable
  empty-composer fallback. The new extra rows do not authorize delivery or an automatic menu action.
- Existing trust and rate-limit actions retain their shapes. Sign-in is held for a person.

`codex-0170-audit.test.ts` pins these readings and compares both versions. The 103 representative normalized frames
include four ANSI references; the other 99 retained exactly the raw frames' production-classifier readings after
normalization. Visible-text redaction handles UUIDs split by ANSI styling and wrapped project-path fragments.
Paths use audit placeholders, UUIDs are synthetic, and the loopback port is fixed. No profiles, raw
request bodies or host process logs are committed. `sources.json` maps each frame to its relative capture name and
SHA-256. `model-switch.json` contains only bounded outcome metadata and the last mock request's model/effort.

## Source checks

Compared official `rust-v0.169.0` and `rust-v0.170.0` sources:

- All 62 state migrations and the relevant state schema, home/socket/daemon and model-cache implementations are
  unchanged. Five owned state databases per version actually reached migration 62. Required thread columns remain.
- The optional rollout `payload.id_allocation` metadata does not change flattened item fields or string IDs. Existing
  readers ignore the extra allocation metadata.
- Of 56 selected trust/login/approval/precaution/lock/resume/rate-limit producers, 54 are byte-identical; two only ignore
  `ThreadStreamReconnected`. Choices, shortcuts and dialog gates do not change. Cloud-stream and multi-backend Command
  Center changes are separate from the embedded local launch exercised here.
- The reported Analytics/external-writer/provider-mismatch strings and rate-reset timeout diagnostics already exist
  in both releases. Tier lowercasing is covered by the case-insensitive status grammar.
- AgEnD's forced startup update override selects embedded app-server mode. The rig's guarded process-kill scan found
  no owned app-server to kill; this does not claim a live reconnect test.

References: [status rendering](https://github.com/openai/codex/pull/61141),
[panel refactor](https://github.com/openai/codex/pull/61167),
[resume comparison](https://github.com/openai/codex/pull/61136),
[tier casing](https://github.com/openai/codex/pull/60972).

## Validation and limits

The new owned-home control failed before its rig change, then passed. The bounded affected set passed **277/277**
across ten files; source/test typechecks have zero errors. The final three changed suites pass 83/83 (the fixture/privacy suite 55/55); its visible-redaction
guard first failed on segmented ANSI identifiers and then passed after normalization was corrected. The detector manifest was regenerated and `--check` reports
it current. Commands and capture drivers are in `scripts/manual/codex-version-audit/`.

This audit proves Linux x64 rendering and local/mock behavior. It makes no real-account, cloud-service or Windows
runtime claim. A new upstream screen still needs its own fixture. Rollback is a code/test revert with no data
migration; the upstream state migration set is identical. Mark the release audited after the main and dev changes merge.

The mock-profile guard controls are load-bearing: removing the explicit inert-auth requirement fails its dedicated
case, and enabling provider auth fails the positive profile check (six cases collected in each control). These are
string/config tests; neither control launches a CLI or uses a login.
