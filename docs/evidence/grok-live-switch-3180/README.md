# Grok verified session switching (M-3180)

Grok joins the generic switch route from #3997 and the representable model+effort parser repair from #3998. Its entry carries the configured supported effort, verifies a new exact CLI notice, and otherwise retains the saved configuration and restart fallback.

Actual copied Grok 1.0.70 ran in owned netless mount/PID/network namespaces with hidden host HOME, a private tmux socket and a loopback dummy catalog/key. No real account/model request, live pane or Fleet was used. The floor is the oldest retained complete switch contract, not a claim of first introduction. Exact fixtures and the binary hash are in tests/fixtures/grok-model-switch-3180.

The production Daemon/TmuxManager route confirms both model+effort and effort-only in daemon-proof.log. Initial compositions discriminated the shared parser bug (both-valued switch downgraded to legacy raw input) and a missing rig AGEND_TMUX_BIN override (safe busy refusal). The final rig uses its explicit tmux and a fresh owned pane for the positive route. When an identical transient notice is already in captured history, a new notice may not add an occurrence; that remains unconfirmed and conservatively restarts, rather than accepting stale text. No guard was bypassed.

Fail-first: without the Grok table entry the new integration suite fails 7/8. With the entry restored, Grok pure + Fleet integration + precheck pass 99/99. Source/test typechecks pass. Configured supported effort, persistence, unsupported versions, busy/refused/unconfirmed restart and invalid single-token model refusal are pinned.

Audit: scripts/manual/grok-version-audit/README.md. A model-only command may open a picker; no picker navigation or guessed selection is added. A response-layout drift falls back to restart. Rollback: remove grok from CLI_RUNTIME_SWITCH, or revert this PR. No changes to Codex or Claude switching.
