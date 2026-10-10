# Codex 0.162.1 audit

Audited on Linux before changing the host's Codex installation. The reference
release is 0.162.0; production AgEnD source is unchanged. Exact source and binary
identities, the complete compare file list, and E2E counts are in `manifest.json`.

## Verdict by surface

| Surface | Verdict | Evidence and limit |
|---|---|---|
| Idle/busy/input/status footer | Safe | Paired native mock-backed captures have the same production predicate results. |
| Resume, session lookup, state DB, rollout | Safe | Real exact-cwd/runtime E2E: 6/6 on each version, zero skips. Core and state trees are identical between tags. Loading remains unavailable; the intended thread resumes. |
| Approval | Safe by source comparison | Approval overlay/events and app-server trees are identical. No new live approval request was generated. |
| Folder trust | Safe | Native untrusted Git/nested-directory prompts hold; pretrusted launch reaches idle. The nested directory is inside the audit repository, so it is not a standalone non-Git control. |
| Onboarding | Safe | Empty-home native sign-in menu remains held without automatic keys. No login was attempted in this probe. |
| Rate limits and errors | Safe | Native 401, 500, usage-limit, capacity and both model-picker widths read the same. Escape returns to idle. Historical Luna Reserve/key-label tests also pass. |
| App-server startup | Safe for the exercised paths | Real E2E covers private runtime directories, legacy links, managed startup and `--no-daemon`. Compatibility now compares explicit CLI feature overrides, excluding managed requirements; file/default differences no longer request a restart. Transport/protocol implementation is unchanged. |
| Multiline async question | Safe conservative admission | Upstream rendering snapshot, not a native capture: no delivery-ready/idle proof or automatic keys. The patch preserves logical lines and hyperlink ranges. |

The [official release](https://github.com/openai/codex/releases/tag/rust-v0.162.1)
contains two fixes: question rendering and daemon feature compatibility. GitHub's
compare API reports diverged history. A direct two-tag Git diff independently
confirms the same 10 changed files (228 insertions, 82 deletions); no additional
resume, approval, trust, onboarding, rate-limit or error renderer changes occur.

## Capture method

Both npm packages were installed under private prefixes. The existing
`scripts/manual/codex-version-audit` rig ran each version on its own named tmux
socket, scratch HOME and isolated Codex home, with a local Responses mock and no
credentials. Final error probes used separate fresh sessions and waited through
retries, avoiding a mock-mode change while an earlier turn was still retrying.
These fixtures preserve native layout, Unicode and version labels; only scratch
paths, path run identifiers and mock ports are normalized. Trailing empty
viewport rows are omitted from the saved E2E loading panes; raw captures retain them.

`resume-loading` comes from `tests/codex-exact-cwd-resume-e2e.test.ts`, run through
the explicit opt-in config. Its existing login-symlink recipe was used without
copying credentials, sending a prompt or spending a model turn. The patch-level
version was already admitted by the existing gate. Temporary pane-capture
instrumentation was restored byte-for-byte afterward. Private session lists were
empty before creation and after teardown; the live/default tmux server was never
connected to. No fleet or adapter was started.

The source-derived binary scan found 46 of 279 candidate literal fragments in
0.162.0; all 46 have identical counts in 0.162.1. This is a byte-presence check,
not proof of reachability or complete regex coverage. Dynamically assembled key
labels and text are covered by source/native controls instead. A separate broad
`Context` count changes from 633 to 635, while the captured footer and its owning
source remain unchanged.

## Reproduce the saved-frame checks

```sh
npx vitest run tests/codex-01621-surfaces.test.ts tests/codex-0162-surfaces.test.ts tests/codex-0162-key-labels.test.ts tests/codex-version-audit-rig.test.ts
```

The suite reads fixtures only. No native CLI, tmux or network call is made. Native
reconnect failure, update picker, async-question execution and macOS were not
rehearsed in this audit; those claims are limited to unchanged source/literals or
the explicitly labelled upstream rendering snapshot. No production fix or host
upgrade was performed; rollback is removal of this fixture-only change.
