# Managed Claude launch evidence

Scope: ordinary local host profiles only. Organization-managed Claude settings are unsupported; no MDM, Registry or live-server policy attestation is claimed. No new dashboard paste flow is offered in this slice.

The final synthetic fixtures bind HOME, AGEND_HOME, CLAUDE_CONFIG_DIR, source/policy paths and fake binaries to private scratch directories. Child environments are built from an allowlisted test base and generated synthetic credential strings; no vendor credential is a test input. Raw private logs are not published.

- First integration set (launch, credential profile, Classic guard ports/control and effort): five files, 63 passed. After the cleanup change, launch + daemon files passed 65. Final own file passed 13 after profile/binding, isolated homes and policy controls; source/test TypeScript checks exit 0.
- Eight reversals were assertion-caught: environment clearing, pipe lifetime, legacy key-tail approval, helper-command binding, cleanup after credential removal, source-class verdict, post-probe revision and post-probe settings checks. The last three reverse the compiled standalone runner actually used by the child-process tests. Two later narrow source reversals pin profile binding before effects and file-policy fragment refusal. No build/transform error counted as a caught reversal.
- CLI source-only observations: Claude 2.1.329, network namespace with empty owned homes and synthetic values. Its `auth status --json`, including the explicit application settings path, selects the expected helper or OAuth-token class. This does not validate a credential with Anthropic. The auth-status command did not run the synthetic SessionStart hook. No model requests or real account were used for these commands; no terminal pane, live Fleet or Windows UI was started.
- Fake-CLI subprocesses verify actual helper-pipe value digests, child-only token environment, cleared competing key/provider values, resume/model arguments, stale replace/remove refusal, wrong source, settings/revision changes during the probe, safe error output, and preserved Classic guard configuration without a fabricated ready receipt.
- `cli-upstream-precheck` passes with the new backend argument construction; no detector-manifest change was required.

Commands: `node node_modules/.bin/tsc`; `node node_modules/.bin/tsc --noEmit -p tsconfig.test.json`; `node node_modules/vitest/vitest.mjs run` with the named focused files. Synthetic and source-only results are deliberately separate from provider validation or native guard campaigns.

Rollback: stop/disable managed-profile consumers before a downgrade, retain encrypted vault/key, and choose an explicit supported profile before resuming. Removing only the wrapper is not a safe rollback: an older binary could revive an ambient login. UI source-transition/restart/status work remains in the dependent slice.
