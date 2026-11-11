# #2301 acceptance — exact pane/session paste proof

Alpha product source: `6fd5edd59eb84dc17e05eeb5cc05888edcae82b9`; the accompanying manifest binds the relevant product bytes and six PNGs. A later evidence-only commit does not change those bytes.

| Check | Result |
|---|---|
| Unmodified alpha `fa5407a3d`, same fresh recorded0.167 stream | consumed raw text remains `uncertain`, about8.8s; one paste/Enter |
| Candidate, exact pre-write session/file/offset | `delivered` during normal confirmation, about0.77s; one paste/Enter |
| Switch UUID after Enter | `uncertain`; one paste/Enter, no resend |
| Replace rollout inode after Enter | `uncertain`; one paste/Enter, no resend |
| Narrow Context after Enter | `uncertain`; one paste/Enter, no resend |
| Unit boundaries | metadata id/cwd/root, ambiguous files, partial EOF, symlinks, opened-descriptor replacement race, deadline/single-flight retirement, owner/window/launch/dialog/capture losses and no revival pinned |
| Focused suites | 79 files;1477 pass,7 opt-in real-CLI tests skipped; no account execution |
| Type checks | source and tests native TypeScript checks pass |
| Semantic reversals | main shared-helper11/11 evidence carried; alpha native-local-proof exclusion compiles and fails its assertion when reversed; restored control passes |
| View | real shell/private tmux, zh-TW desktop+phone; six screenshots, no page overflow/CSP violation |
| Cleanup | each replay's private tmux and scratch HOME removed; web fixture/probe pool/browser/listeners closed |

Times describe this offline replay, not a latency SLA. The raw text/frames are from a pinned real Codex0.167.0 run against a loopback Responses mock in a network-isolated scratch rig. The replay uses an inert renderer, not a live backend CLI. Startup/idle IPC is inert; the actual binding, incremental reader and durable receipt settlement run. See [fixture provenance](../../../tests/fixtures/codex-pane-owner-2301/README.md), [design](../../design/codex-pane-ownership.md) and [repeatable recipes](../../../scripts/manual/codex-pane-owner-2301/README.md).

## View before / after

Desktop uses the normal120-column pane and View Fit. The complete UUID, Context and model remain visible; the long cwd is the lower-value truncated item. Phone uses the existing Aa control Fit→S to make the UUID and Context readable; the model/cwd can be reached by horizontal scrolling at that chosen zoom. No View code or CSS changes. Narrow screenshots show a45-column captured pane and cannot bind a UUID. CJK fonts are explicitly supplied to the scratch browser; synthetic fixture names only.

| | Before | After | Narrow / uncertain |
|---|---|---|---|
| Desktop | ![Before](desk-zh-TW-before.png) | ![After](desk-zh-TW-after.png) | ![Narrow](desk-zh-TW-narrow.png) |
| Phone | ![Before](phone-zh-TW-before.png) | ![After](phone-zh-TW-after.png) | ![Narrow](phone-zh-TW-narrow.png) |

Known limits: an unwritten/missing session, unsupported metadata or incomplete footer supplies no new transcript authority. Current cwd progress selection, resume policy and Codex `getSessionId() === null` stay unchanged. A lease is runtime-only, cannot be reconstructed after restart, and loss never revives. No native-Windows or real-account claim.

## Alpha-specific preservation and rig configuration

The native Runtime durable-checkpoint union and existing native readers remain intact. This local proof explicitly excludes nativePaneLifecycle (pinned by the alpha-only test and native-exclusion mutant). Native sequence/current checks and the Context-only Runtime footer are unchanged. The new footer reader is on CodexBackend, leaving alpha's shared detector class intact. The delta reader imports alpha's transcript-needles module. The manifest was rebuilt on alpha.

The View recipe uses the production tmuxArgs and an explicit `/usr/bin/tmux`3.7b utility override inside its scratch HOME. The configured79-file run uses `AGEND_TMUX_BIN=/usr/bin/tmux`. Before configuration, two device-hint real-pane cases failed identically on this checkout and untouched alpha; they require a source-install bundled-tmux receipt or valid utility override. The configured run passes all1477 tests. No product timeout or guard was changed.

The fallback regression is byte-identical to the main replacement test: a real bound lease switches after paste before the marker arrives, or before final settlement, and saves the binding-lost reason with one paste/Enter. The fake clock also pins prompt retirement after an empty read instead of another poll. Alpha scoped9-file control:135/135; test types clean. `fallback-review/` holds independent alpha reversals. Product hashes correspond to6fd5; the later manual-script, tests and evidence commit does not change product bytes.
