# Grok 1.0.89 compatibility audit

M-3335 compares 1.0.88 with 1.0.89. The upstream precheck reports one
unhinted usage-limit/authentication string and four hinted changes around
build, trust and rate-limit surfaces. Static strings identify what to
probe; they do not establish how the terminal renders or behaves.

## Isolation and evidence

Run the downloaded real Linux CLI directly in a scratch HOME and a private
tmux server inside the existing network and mount namespace harness. Use
only the local model API mock and a dummy key. Never load a real account,
update an installed CLI, attach a Fleet pane or invoke a Fleet lifecycle
handler. Every wait is bounded, every capture must be nonempty, and the
controller closes its own children and socket. No browser is needed.

Retain binary version, download provenance and SHA-256. Exercise startup
trust and unauthenticated hold, ready/busy/cancel, short and multiline
drafts, queued input and structured consumption records, tool/MCP calls,
approval refusal, weekly limits, error/retry screens, model/effort changes,
compact/new/resume and exit. Capture 120-column screens and 80-column
wrapping cases. Record unreached/account-dependent paths separately.

The focused error matrix compares authentication failures with usage
limits returned as 401, quota/credits, 403, 429 and server errors. Inspect
the active terminal before selecting any dialog action; never guess a
paid option. Reuse 1.0.88 fixtures and probe that binary only where a new
rendering or key contract needs a direct comparison.

## Change and verification

Feed the saved real screens through production startup/runtime dialogs,
busy/ready/input readers and error patterns. If a new usage-limit screen
would pause for authentication, first pin that misclassification with a
failing fixture test. Add the smallest framed/contextual quota rule ahead
of the broad authentication backstop; preserve genuine authentication
errors. Include wrapped screens and near-miss user/code prose. Apply the
same fail-first process to any trust/rate-limit drift found live.

Run the affected Grok suites, source/test TypeScript and a compiling
reversal of each changed detector. Rebuild the detector manifest on each
base. Keep captures generic and sanitized; store path and digest as
separate fields. Run the private public-text checker on the diff, body
and decompressed evidence before pushing or posting.

## Delivery

Deliver main first and then the dev twin from its actual current tip.
Keep the detector change equivalent across branches and account for
their different audited-version registries. Each PR starts its body with
`Author-instance: agend-dev-sol2`, includes acceptance before review, and
gets Fable's exact-head approval plus successful CI. The coordinator
alone merges. Mark the upstream release audited only after merge.

The report separates live-terminal evidence against mock responses from
static-only or unreachable findings. Rollback reverts the narrow detector
and manifest/ledger changes; it does not alter installed CLI or account
state. No claim of successful real-account login or Windows execution
is made by this Linux mock-backed audit.
