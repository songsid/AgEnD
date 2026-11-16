## M-3256: room participant source badges

Product source: `b03b0c72ac58c20f91a5b6fd3ba57d5ee9c18c04`, based on alpha `be7ae0f10`. The manifest binds all 21 changed input paths. Eight final served runtime assets, including the fixed AgEnD SVG, match the current source bytes.

Plain alpha sync: `41ac8ef30717c04e437900f4ae3a937fe7ef4629` consumes current alpha `47701428f95a15035d6e0ff567c57f6fb17dde56`. Twenty own non-overlapping blobs/modes are unchanged; all 84 incoming-only paths equal alpha. The only automatic overlap is the HTTP module inventory file. Applying the original own patch to alpha in an isolated index reproduces the entire merged tree exactly (see [alpha-sync.json](alpha-sync.json)). Per decision 5afe2996, the sync adds no local rerun or new source-review campaign; final CI must bind the new head.

AgEnD agents receive the bundled silver mark. App posts retain “Casey via Claude Code” / “Casey via Codex” with the same generic app glyph. Lumen specified a generic glyph because OAuth names are unverified, and specified that person rows remain unchanged. Agent rows and headers have localized hover/accessible explanations; phone users can tap to read the same text. Personal-source rendering is unit-tested, without claiming a mounted personal-agent host.

| Verification | Result and scope |
| --- | --- |
| Original baseline | Two semantic assertions fail: missing mapped source badge and missing member marks. |
| Affected tests | 117 distinct controls across nine files: 112 existing controls plus five new source tests. An initial two-test harness failure (missing `onEmpty`) was corrected; the affected file passes 5/5. |
| Visual regression | Initial pictures exposed duplicated author text. Two EN/zh assertions reproduce it; clearing the unmanaged sender text makes the five source tests pass. |
| Final focused delta | Source UI, member panel and CSS suites pass 24/24; overlaps the 117 controls. Unknown older metadata uses a generic AgEnD explanation. The phone detail notice wraps rather than using the ordinary single-line pill. |
| Types | Source program exits 0; the final test program exits 0. TypeScript runtime paths remain unchanged through the DOM/notice refinement. |
| Actual Hub | OAuth MCP posts, HTTP, SQLite and real audit, with inert directory/member input. Corrected-header combined desktop/phone run passes 29 checks. Final phone-only detail run passes 22 checks; the counts overlap. No repeated CLI/model campaign. |
| Full layout gates | Hub shell: 696 checks pass. Hub UI: 366 checks pass. Both run headless in Linux with `GATE=full`. |
| Images | Three before plus four preferred after originals, inspected visually. Two historical failure images remain separately. |

The before capture's first run retained its desktop originals but used an English-only attribution assertion for zh-TW; only the phone was retried with a language-independent check. The first layout-gate launch used the wrong executable basename; the next process was terminated (143) without a result. The final bounded serial run completed both gates. These setup/incomplete attempts supply no passing gate claim.

Public logs replace the checkout prefix with `<repo>` and are stored as lossless `.log.gz` files, preserving their trailing blank lines. Use `gzip -dc` to read them; private originals remain in the owned artifact directory.

## Preferred originals

| View | Before | After |
| --- | --- | --- |
| EN desktop light, thread | [before](before/desk-light-en-thread.png) | [after](after/desk-light-en-thread.png) |
| EN desktop light, members | [before](before/desk-light-en-thread.png) | [after](after/desk-light-en-thread.png) |
| zh-TW phone dark, thread | [before](before/phone-dark-zh-TW-thread.png) | [after](after/phone-dark-zh-TW-thread.png) |
| zh-TW phone dark, members | [before](before/phone-dark-zh-TW-members.png) | [after](after/phone-dark-zh-TW-members.png) |

The wide thread and member list share one frame, stored once: seven unique preferred images. [Phone tap explanation](after/phone-dark-zh-TW-tap.png). The desktop images are retained from the corrected-header stage; the final notice-only refinement changes no content visible in those images. Separate served-asset receipts preserve each stage rather than relabeling older captures.

## Reproduction and limits

Focused tests: `vitest run tests/hub-room-source-badges-m3256.test.ts tests/hub-room-members.test.ts tests/hub-room-thread-3092.test.ts tests/hub-shared-modules-a.test.ts tests/hub-mcp-door-m3240.test.ts tests/hub-room-agent-mentions-3118.test.ts tests/ui-css-literals-ratchet.test.ts tests/i18n-ui-literals-2390.test.ts tests/ui-zh-terms-815bfe4a.test.ts --maxWorkers=2`. Refinements rerun only affected suites. Types use `tsc --noEmit -p tsconfig.json` and `tsconfig.test.json`.

The manual runner is `scripts/manual/hub-room-source-badges/browser.mts`, using owned `PW_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, `CERTUTIL` and `FONTCONFIG_FILE`, plus `STAGE`, optional `CASES`, and `OUT`. It checks Linux and load ≤10 before creating resources, uses an isolated home and a rig-only trusted CA, never ignores TLS errors, and closes its browser/server/clients and removes keys in `finally`. Layout gates use the existing headless smoke runners. No Windows browser, user desktop window, live Hub/Fleet/AD, real CLI/model or production package was exercised.

Rollback reverts the cosmetic renderer/projection delta. No stored history, schema, source authority, content ownership, audit behavior, capability or membership change needs reversal.
