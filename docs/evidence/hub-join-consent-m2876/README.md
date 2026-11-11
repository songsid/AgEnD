# Fleet-admin company sign-in consent (M-2876)

A signed-in Fleet administrator's **Sign in with company account** press is local consent (decision a9ccee59, 2026-11-11). It opens the existing Hub handoff. There is no separate confirmation, Apply action, held General card or extra Hub approval for an allowed group. An administrator who requires their own remote authenticator enters its six-digit code inline. The existing host-only setting, private cookie session, current Fleet-admin role, Origin/CSRF and Hub authority still apply.

The old waiting tab knew only a handoff id. Its Review fallback navigated to Needs-you, which does not attach Settings confirmations, so the pending card was absent there. The operation journal is created only after the confirmed replay; its absence before that is expected. The fix uses the existing claim/replay and exact operation discovery, with a dedicated inline presentation and a reload-safe, cookie-owned code prompt. It also shows where to copy the link, why an empty Start is disabled, the submitted target, and the Hub administrator's three colleague-connection steps. No pairing path, credential format or Hub policy changes.

## Source and results

The definitive browser and retained-module runs capture clean source **0af23deb43cbf8d178a27c5e9462299e8081c695**, with tree, input and served-body digests in each original receipt. Later evidence commits do not relabel those executions. The changed product and test blobs are unchanged from the focused/native-type runs. Earlier interrupted/harness-debug runs are not counted as acceptance.

| Check | Result and scope |
|---|---|
| Pinned baseline fail-first | Five assertion failures on alpha `3dd72e50`; candidate tests at `5a0bc975`. Both host/nonhost ordinary consent and enforced-code presentation, plus the missing-card destination. No load/type error. |
| Focused tests | 296/296 across 13 files, including private session authority, local join, Hub HTTP, code enforcement, claim store, mounted UI, localization and Settings search. |
| Native source/test types | Both pass with `node node_modules/@typescript/native/bin/tsc --noEmit`, adding `-p tsconfig.test.json` for tests. |
| Guard reversals | Nine of ten independent mutations fail assertions; restored 38/38. C6 survives equivalently: both expressions read the Start closure's original form state. Full patches and failures are in `mutations.json`; not all ten are claimed killed. |
| Real join matrix | 10 journeys / 124 checks / 40 PNGs: eight EN/zh-TW × desktop/390px phone × light/dark cases, plus desktop-EN/phone-zh enforced-code cases. All reach the existing pinned member link online; no General card, no extra per-Fleet approval. |
| Before assets | Four EN/zh desktop/phone journeys. Only the listed UI modules are substituted from `3dd72e50`; the backend is the candidate. This is before-presentation evidence, not an old-backend execution. |
| Retained assets | Old confirmation module, old join panel, or old join strings served separately with the remaining candidate modules/backend. Each uses EN desktop and zh phone. Receipts name the exact substituted Git bytes. Feature-disabled server composition and legacy pending responses also retain their existing path in tests. |
| Settled admin control | At clean source `a4ed2210c`, an additional phone-light-zh journey and both code controls pass 44 checks. The admin capture waits for the real copy-link button to become enabled. The original full matrix’s phone-light-zh admin image caught its loading state and is preserved unchanged. |
| Style gates | Settings CI matrix 114 checks; Hub CI matrix 79 checks. The dedicated journeys additionally measure new phone code controls and connected-card controls, using checkbox labels as their actual targets. |

CSS is byte-identical to the baseline, so the candidate runs use the same CSS with the new modules. Retained-asset tests do not claim every mixed module combination, a deployed older backend, Safari, or a real account.

## Original screenshots

- Fleet empty guidance: [EN desktop](browser-pass/desk-light-en-empty.png), [zh phone](browser-pass/phone-dark-zh-TW-empty.png).
- Existing Hub sign-in: [EN desktop](browser-pass/desk-light-en-hub-signin.png), [zh phone](browser-pass/phone-dark-zh-TW-hub-signin.png).
- Personal enforced code: [EN desktop](browser-pass/desk-light-en-code-code.png), [zh phone](browser-pass/phone-dark-zh-TW-code-code.png).
- Connected: [EN desktop](browser-pass/desk-light-en-connected.png), [zh phone](browser-pass/phone-dark-zh-TW-connected.png).
- Hub colleague guide: [EN desktop](browser-pass/desk-light-en-admin.png), [zh phone](browser-pass/phone-dark-zh-TW-admin.png).

The settled [phone-light-zh admin original](settled/phone-light-zh-TW-admin.png) supplements the earlier loading-state image without replacing it. All originals are in the adjacent matrix directories. Fleet pages use the actual Settings sidebar with Hub selected; Hub pages use the landed Hub shell.

## Replay and boundaries

Run `scripts/manual/hub-join-consent-m2876.mts` from a clean candidate checkout with `REPO`, `OUT`, a short owned `TMPDIR`, Playwright `PW_DIR`/`CHROME`, and prepared CJK `FONTCONFIG_FILE`. `MATRIX=full` runs the definitive matrix. `BEFORE=1 MATRIX=desk-light-en,desk-light-zh-TW,phone-dark-en,phone-dark-zh-TW` substitutes baseline UI. `SKEW=settings-confirm.js`, `settings-hub-company-join.js`, or `hub-company-join-strings.js`, each with `MATRIX=quick`, runs the retained controls.

The rig uses isolated HOME/storage, actual Fleet cookie/CSRF/claim/replay, real Hub HTTPS/SQLite/enrollment/TLS/WSS and the production AD driver against an owned verified fake-LDAPS peer. A forwarded documentation peer models a remote Fleet admin and the actual authority is asserted nonhost. Fake binaries and inert lifecycle refuse native/model/daemon work. Browser routing only redirects fixture traffic and substitutes the explicitly recorded retained assets; product API responses are not stubbed. Every receipt records cleanup. The shared fixture emits an exit-listener warning after many cases; no limit is raised and all resources are closed.

No live directory/account, AD writes, real Fleet, pilot modification or deployment is part of these executions. No private pilot material is included. A screenshot does not prove a new authority path: the underlying HTTP and local-authority tests provide those controls.

The intended authority change admits a currently signed-in Fleet admin's click under the accepted lenient policy; their personally enforced remote code still applies. Reverting the PR restores the previous confirmation presentation. There is no new schema/data migration; retain existing bindings, journals and pins when reverting.
