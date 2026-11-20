# Get a setup-token from the dashboard

The existing Connect-account session runs a fixed `claude setup-token` command under a fresh scratch HOME/config. It keeps the same verified local authority, backend writer lock, 10-minute monotonic deadline, bounded output/input, current-owner checks, serialized controls and confirmed teardown. No real account, credential, provider or model is used in this evidence.

A private-output variant of the existing dedicated tmux transport creates the final pane after setting history-limit to zero. Its capture API refuses. Raw output travels through the existing memory/FIFO stream, never through a browser terminal, snapshot, log or SSE. A server-generated completion marker on that same stream prevents pane-death from overtaking the last token bytes. The token is consumed once; the private server and scratch config are removed before the existing vault lifecycle transaction can commit. A teardown failure retains the shared claim and refuses the write. Current private pane content and process memory can still be inspected by the same OS user; this is not isolation from that user.

Validation:

- Fourteen affected/policy files: 240 assertions pass; source and test TypeScript pass.
- The complete existing real-resource terminal file: 30/30, using private scratch sockets. The new case runs a generated local fixture executable, proves history `0 0`, capture refusal, one-use consumption and directory removal. No account login or fleet is started.
- Six assertion reversals caught: one-use consumption, private-output mode, completion-stream fence, teardown before commit, original claim and current owner. All sources restored.
- Thirty-four real-app images: EN/zh-TW, desktop/phone, light/dark. The isolated app uses the real verified API and vault, with a synthetic login transport. All views have no overflow, undersized phone controls, exposed input, page error or CSP error. Paired overview/scrolled images demonstrate the full Cancel action and retained paste input.

Commands: `node node_modules/.bin/vitest run tests/claude-setup-token-m3419.test.ts tests/web-claude-setup-token-m3419.test.ts` and the affected HTTP/lifecycle/sign-in neighbors; `AGEND_TMUX_BIN=<owned test binary> node node_modules/.bin/vitest run --config vitest.config.integration.ts tests/web-terminal-integration.test.ts`; source/test `tsc --noEmit`.

[Gallery](gallery.md) · [Capture results](capture-results.json) · [Reversed controls](controls.json) · [Style audit](style-audit.md).

Rollback: remove the optional fetch flow and its private-output adapter; keep paste, the encrypted vault and the guarded launcher. Never change the selected source implicitly. Website publication remains held until the feature beta and user approval of its captures.
