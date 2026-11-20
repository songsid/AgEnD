# Muse 1.4.24-R9131.1 audit (M-3396)

Compare the real 1.4.24-R9131.1 binary with 1.4.23-R8977.1. The upstream precheck
flags a new rate-limit retry string near usage-limit text, changed header count,
and permission neighbours. Binary adjacency is not a screen classification.

Run both exact binaries offline in separate bwrap namespaces, scratch homes and
a private tmux socket, with a deterministic local Meta-provider mock. Never use
the installed Muse launcher, host credentials or default/live tmux. Heavy runs
inherit nice/ionice. Save actual pane captures and mock requests, and classify
ready/busy/draft/runtime+startup dialogs/errors using the existing backend.

Cover trust/login, fresh/idle/busy/cancel/resume, successful local model turn,
permission requests and refusal, HTTP 429 while retrying and after exhaustion,
and HTTP 402 quota. Probe changed wrapping at desktop and narrow widths. Existing
unrelated memory/workflow coverage remains the prior audited control unless the
new binary or captures show a material delta requiring it.

Only change detectors if actual captures prove a gap; otherwise add fixtures and
a no-detector-change comparison. Add the dev audited ledger and target tests in
the dev twin. Rebuild the precheck manifest if detector declarations change.
Acceptance and evidence precede parity review. Main first, then a standalone dev
twin from its actual tip; coordinator alone merges. Mark the external audited
ledger only after the required merges. No real-account request is authorized.
