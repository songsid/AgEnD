# ClassicBot suggestion dismissal (M-3410)

Base: `232f0fc2d`. Disposable fixtures only; no real room, account, or production configuration is included.

## Cause and limits of the incident evidence

Later posts `/ui/needs/ack`; it does **not** write dashboard preferences. The base route required `contactActor`, the same verified action identity used for contact approvals. A signed-in room administrator whose browser has no current action verification therefore gets 403, locally or over a public link. The client discarded the response body and rendered every failure as “Couldn't save.” The route also swallowed storage exceptions as the same unlogged 403. The original screenshot cannot establish the request's surface or status; the unverified-session failure is reproduced, not inferred as a proven attribute of that screenshot.

## Change

Reminder dismissal has its own narrow admission: a real admin session, its server-stored person identity, and the existing current room-admin/adapter namespace check. It does not manufacture web-verified authority. Unknown persons still need verification; readers, CLI tokens, other namespaces, removed admins, missing CSRF and revoked sessions are refused. Unverified admin sessions see only the benign room suggestions, never pending contact tickets. Permission changes, contact decisions, origins and room mode retain their existing guards.

Refusals and transport/storage errors have EN/zh-TW recovery copy. Unexpected save failures return 503 and log only a safe error code; raw exception text is not returned. Detailed errors last 12 seconds and wrap on phones, retaining the corrective action.

## Validation

- Initial fail-first set against the base: **8 failed / 6 passed**. The local/public unverified admin success cases fail as 403; storage failure is falsely 403; the five reason-specific UI cases show only the generic text.
- Final regression and neighbours: **98/98 across 8 files** (including additional expired-session, CSRF and revocation cases).
- Source and test TypeScript checks pass; final syntax and whitespace checks pass.
- Real dashboard, own scratch server/home, Chromium headless in an isolated network namespace with loopback only. Sessions sign in through the actual form; only external verification/role fixtures are synthetic. The real Classic channel manager, web handler, outbox store and reminder write execute; no client route is mocked. Verification is withdrawn after the cards are shown: the room admin's Later returns 200 and persists the dismissal. With room-admin membership removed, Later returns 403 with the full recovery message. Both desktop dark zh-TW and phone light EN have no page/CSP errors, and the refusal text fits without clipping.

Screenshots: `desk-dark-zh-TW-before.png`, `desk-dark-zh-TW-success.png`, `desk-dark-zh-TW-refused.png`, and their `phone-light-en-*` counterparts. These are product UI, not drawn HTML. Capture recipe: `scripts/manual/smoke/smoke-contact-later-m3410.mts` with the shared smoke fixture; supply REPO, PW_DIR, CHROME and OUT, a scratch HOME, a CJK-capable FONTCONFIG_FILE, and run netless/headless.

Risk: this intentionally lowers only the acknowledgement requirement for identifiable, current room admins; it grants no agent-action authority. Rollback: revert the commit; existing dismissal rows remain benign and no schema migration is introduced.
