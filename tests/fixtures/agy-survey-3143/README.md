# M-3143: rating survey and nonblocking announcement

`reported-rating.txt` is the user's reported wording, NOT a real-screen capture.
The straight-apostrophe, split-line and composer variants in the test are
conservative synthetic layouts. They require the exact question and
`[1/2/3/0]` marker at the interactive bottom, with no draft or quoted reply.
A future real rating-screen capture may tighten this provisional matcher.

The two `captured-*.txt` files are real `tmux capture-pane -p` output from the
official Linux x64 agy **1.5.9**, captured on 2026-11-15 in an owned private tmux
and scratch HOME/cwd. Email is replaced with `[account redacted]` and the scratch
cwd with `/scratch/agy-work`; all other visible text/spacing is retained.
The archive SHA512 matched the official updater manifest. The host's installed
CLI and live panes were untouched. Existing sign-in was mounted read-only into
the sandbox, never copied; no token or authorization URL is in these fixtures.

Terms Interactions-data sharing was unticked and verified before Done. Settings
showed telemetry off and Show Feedback Survey on. Five initial tiny replies and
a specifically authorized additional 15 one-line no-tool replies completed
without a rating survey. `/feedback` and `/feedback survey` opened a different
qualitative report form; it was cancelled and no feedback was submitted.
Model calls stopped at the bound of 20 total. No telemetry/privacy setting was
turned on to provoke the survey. The scratch sign-in/runtime is removed after
capture; only sanitized non-secret fixtures remain.

The account received the Hydrogen announcement, not the reported “Auto is now
the default agent mode … esc to dismiss” announcement. The Auto-default prefix
substitution in the test comes from the report, not a captured second banner.
The existing M-3116 composer matcher ignores announcement wording; no automatic
Escape is added. This is targeted compatibility evidence, not a full CLI audit.
