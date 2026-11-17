Guest Discord mentions in the web chat

At source `3ac5e91283cc35be36854bfe48a81d90a8b2c800`, guests receive cached mention labels with messages they may already read. The shared mention renderer and its existing pills are reused; there is no new markup, CSS or guest directory route.

Root cause: `src/ui/chat-mentions.js:42` at baseline `0f61ea1f` requests `/ui/mentions`. `guestRouteDecision` in `src/web-guest-access.ts:87–99` rejects that route with 403, correctly keeping the member lookup closed. Without labels, `src/ui/shared/chat-render.js:82–84` renders `@user`. Admin requests succeed.

The server now resolves only tokens in each permitted message, after visibility filtering, from the existing memory-only sources. History, poll, replay and live frames share that projection. The client seeds its mention index from those labels; guest pages never fetch the lookup endpoint. Unknown names retain the existing fallback.

Verification

- Fail first: the admin-name and denied-route controls pass on the baseline; guest rendering fails by assertion. The initial poll failure was a missing-field TypeError, then the isolated poll assertion also fails semantically after optional access is corrected. A prior harness parse error is not counted.
- Focused tests: initial 40/40 across `web-guest-mentions-m3279`, `web-mentions-1682` and `web-guest-access-1920`. Four added live/replay, click-label, bounded-token and client-index controls bring the final new suite to 8/8. Four checks overlap: 44 distinct, not 48.
- Source native TypeScript has no diagnostics. Final test native TypeScript exits 0 after completing the typed test fixtures.
- Real web HTTP, synthetic admin/guest sessions, memory labels, actual history and DOM: before admin shows `@Avery @Blair`, guest `@user @user`; after both show `@Avery @Blair`. The guest makes no lookup request, including a live unknown mention and reload, and another chat remains 404. Arbitrary-id lookup remains 403 in the HTTP test.
- Four original desktop dark EN PNGs were independently inspected. No clipping or layout regression; guest navigation still contains only the permitted agent. No raw user IDs are drawn.

Commands

```sh
node node_modules/vitest/vitest.mjs run tests/web-guest-mentions-m3279.test.ts tests/web-mentions-1682.test.ts tests/web-guest-access-1920.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run tests/web-guest-mentions-m3279.test.ts --maxWorkers=2
node node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.json
node node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
# With REPO, OUT, HP, PW_DIR and CHROME pointing to the isolated Linux fixture:
STAGE=before node node_modules/tsx/dist/cli.mjs scripts/manual/smoke/smoke-guest-mentions-m3279.mts
node node_modules/tsx/dist/cli.mjs scripts/manual/smoke/smoke-guest-mentions-m3279.mts
```

The before run uses baseline product source; after uses the source above. The fixture uses inert agents, no Fleet start, Discord connection, directory, CLI or pane. Both browser runs were headless inside WSL. Browser and fixture listeners closed, and the browser slot was released. Raw test output is gzip-compressed losslessly after replacing local workspace paths with generic placeholders. `manifest.json` binds 12 inputs and 14 artifacts; JSON and image files use fake names and IDs.

Risk and rollback: labels remain dependent on the existing memory caches, so an unknown or evicted name still uses the fallback. Reverting this PR restores the prior guest fallback; there is no stored-data migration.

Before publication, a plain sync consumed alpha `ef092431445257eca02cf5b0a0be66dea241d006`, preserving its public-link refusals and pins. Every own added/removed line remains identical to the tested source; no local verification was repeated for this sync. Exact-head CI applies to the published head.
