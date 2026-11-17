# Grok 1.0.88 compatibility audit

This is the design for M-3291. The upstream precheck of 1.0.77 against
1.0.88 reports `MAJOR`, with one unhinted and four hinted hits. Its strings
are evidence to investigate, rather than proof that the running terminal
changed. The audit will not update the installed CLI or mark a release
audited; the lead does that after review and merge.

## Scope

Use the real 1.0.88 binary and retain its version, download provenance and
SHA-256. Compare the changed screens with the retained 1.0.77 captures;
run the old binary only when rendering or key behavior needs a direct
comparison. The inline model/effort contract also retains 1.0.70 as its
oldest supported contract, as documented in the existing switch rig.

The investigation covers startup trust/login, ready and busy states,
boxed input and cancellation, tool/MCP permission screens, error and
weekly-limit states, new/compact/resume/exit, model/effort switching and
the structured input records used to prove consumption. Each new
prompt-like string gets a disposition: reached on the normal launch
path, reached only by an optional command, or binary-only/unreached.
An unreachable screen is never described as live-tested.

## Isolation and quota

Launch directly in a private tmux server and scratch HOME, with a minimal
environment, dummy key and local model API mock. Reuse the retained
audit and model-switch rigs. Prefer the existing namespace isolation so
external network and host HOME are unavailable. Use a new socket name,
scratch directory and owned loopback listener; never use a live AgEnD pane,
Fleet lifecycle handler, global install or real account configuration.

Record that the captures come from the real terminal while model
responses come from a mock. This exercises rendering, default selection,
keys, persistence and MCP wiring without consuming account quota. If an
account-dependent surface cannot be triggered this way, record the gap
before considering any additional authenticated call. No browser is
needed.

The controller owns its child processes and closes only its own server,
socket and listener. It captures nonempty panes and request counts, with
bounded waits; an empty capture or timeout is a failed step, not parity.

## Evidence and detector changes

Capture a serial matrix at 120 columns and a focused 80-column pass for
wrapping-sensitive screens. Feed saved panes through the production
detectors and input readers. Preserve old-version fixtures. Tests pin
active screens and near-miss prose/history, including stale or quoted
success notices and prompts without their expected footer.

For any defect, first add a fixture assertion that fails with the current
detector, then make the smallest context-bound change. Reversing that
change must fail the new assertion. Unknown or ambiguous screens keep
input held; no generalized `Yes` match or guessed menu navigation is
allowed. Rebuild the upstream detector manifest if its literals change.

Fixtures and logs use generic names, dummy identifiers and normalized
scratch paths. Keep raw captures private until redacted. Public evidence
stores paths and hashes in separate fields, rather than inline path/hash
bindings. Run the private public-text checker before each push or post.

## Delivery

Run the new fixture tests and existing affected Grok detector, input,
consumption and manifest tests. Record commands, counts and limitations.
Compare the touched source against main to decide whether a separate
main twin is needed. Post acceptance for the exact public head before
asking the designated reviewer, Fable. Only the coordinator merges.

The final note distinguishes live terminal evidence from static findings
and lists any unsupported surface. Rollback removes the narrow detector
changes and their manifest update; the installed CLI and account state
remain unchanged throughout.
