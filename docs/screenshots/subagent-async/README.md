# Claude background child state and progress retirement

M-2801 · 2026-11-10 · beta.3 regression. Real Fleet web/admin sign-in, Chrome, and the production bounded filesystem reader; synthetic saved CLI2.1.319 records only. No CLI/model/account/live fleet operation. [Browser receipt](browser-receipt.json) binds exact product hashes; [cleanup](cleanup.json) records the loopback-only user/network namespace, 38 tracked owned processes, zero survivors and scratch removal.

The baseline is the actual beta.3 reader/projector from186b104c reading the same full mixed-record fixture; only module import paths are relocated. The current real shell shows its Unknown result in `*-before-unknown.png`. Candidate files contain every child record type, including the three diagnostics omitted by the old selected fixture. Private acceptance additionally reads the **original unredacted files** via SubagentService ([receipt](raw-replay.json)). Committed fixtures retain every record and identity-field presence/order; API/environment payloads are omitted and owned paths normalized. A live prefix and unfinished meta are explicitly derived from final saved records, not claimed as a separately captured live sidecar.

The observation clock and browser Date are fixed together to test immutable deadlines without waiting two minutes. HTTP and rendering are real; no response stub supplies positive child states. `scripts/manual/subagent-row/async-accept.mts` reproduces the campaign using the owned `smoke-fixture` launcher. Run with REPO, OUT, PW_DIR, CHROME and an owned loopback port; our command ran under unprivileged `unshare -Urn` with only lo enabled. The harness's lifecycle methods remain inert.

| Story | Desktop zh-TW | Phone zh-TW |
|---|---|---|
| Before: genuine mixed-record completion stuck Unknown | [desktop](desk-light-zh-TW-before-unknown.png) | [phone](phone-dark-zh-TW-before-unknown.png) |
| Running, collapsed by default | [desktop](desk-light-zh-TW-running-collapsed.png) | [phone](phone-dark-zh-TW-running-collapsed.png) |
| Running despite parent yield | [desktop](desk-light-zh-TW-running.png) | [phone](phone-dark-zh-TW-running.png) |
| Both completion proofs present | [desktop](desk-light-zh-TW-completed.png) | [phone](phone-dark-zh-TW-completed.png) |
| Completion grace elapsed: clear | [desktop](desk-light-zh-TW-completed-retired.png) | [phone](phone-dark-zh-TW-completed-retired.png) |
| Child evidence missing: Unknown | [desktop](desk-light-zh-TW-unknown.png) | [phone](phone-dark-zh-TW-unknown.png) |
| 120s without new valid proof: clear | [desktop](desk-light-zh-TW-unknown-retired.png) | [phone](phone-dark-zh-TW-unknown-retired.png) |
| Reopen same immutable files: stays clear | [desktop](desk-light-zh-TW-reopened.png) | [phone](phone-dark-zh-TW-reopened.png) |

The corresponding desktop-dark-EN/phone-light-EN cases also pass. Four SKEW cases retain the composer with no page errors: cached beta.3 panel, cached beta.3 child module with new server, beta.3 reader with new client, and missing optional module. New-client/old-server expiry is separately pinned with an immutable original-launch fallback in the UI tests. Old-client/new-server relies on normal polling of the already-filtered server result; an unchanged old browser tab needs the new module to gain between-poll hiding.

Style gate: unchanged native disclosure/.tag/.note/ErrorState and own stylesheet; no markup or CSS redesign, no new controls/shared-module imports. The browser checks44px summary, no horizontal overflow or inline style, outside-ledger placement, visible composer, no child-action buttons, no CSP/page errors. [Visual review](image-review.md) covers16 final main/alpha images, including before/current/retired/reopened and SKEW.

Fail-first: new mixed-stream/lifecycle suite has14 failures on the old product. [Sixteen independent guard reversals](guard-reversals.json) each produce semantic assertion failures, then originals are restored. Tests cover exact message and diagnostic identities, allowed record types, diagnostic timestamps excluded from freshness, original-launch unknown expiry, parent UUID and turn binding, late-completion original timestamp, initial6–11ms write ordering, server/UI retirement, old-server no revival and future-dated launch rejection. The final focused run passes227/227 in11suites; prescribed product/test TypeScript7 checks pass. Existing async owner/auth and read/guest/public negative tests remain.

Limits: this is saved custom Sonnet background evidence, not the leader's separate Haiku bytes. Activity older than30s still becomes Unknown. A child missing/incompatible evidence is hidden after the bounded deadline rather than claimed finished. No new child actions, ledger rows or Hub/guest/read/public data. Rollback is a code revert; no persistence/schema/config migration.
