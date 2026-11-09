# S-119 Story 5 — find allowed groups and people in Administration

The earlier Administration layout separated group permissions, company joining, individual invitations and manual pairing into competing cards. The new leading **Allowed groups and people / 允許的群組與人員** card links to the existing group editor, explains the company connection switch, copies the exact server-supplied colleague address/identity link and presents existing individual Fleet invitations. These invitations permit one Fleet connection only: they grant neither Chat nor Agent-sharing permission. No policy model or authority changed.

Manual pairing remains under **Advanced / 進階**. A generated offer or an owner-confirmed request awaiting administrator approval opens it automatically. All existing create/approve/revoke handlers remain unchanged. Copying a company link creates no offer, invitation or grant. Joining stays off until the administrator uses the existing authenticated revision-checked switch.

## Evidence

- Baseline `ffd4eba02`: 8 desktop/phone × EN/zh-TW × light/dark cases, 10 checks, 16 PNGs in `before/`.
- Candidate, one full run: the same 8 cases, 94 checks, 36 PNGs in `after/`. Off-state explanation; enabled access/individual invitation; exact identity-link clipboard comparison; actual group-editor navigation; manual code through the existing form; overflow and phone tap geometry; no JavaScript/CSP errors. Phone invitation and generated-code images explicitly scroll the complete controls into view.
- SKEW: 10 cases, 41 checks across earlier panel, company component, company strings, owner strings and owner CSS. Earlier JS/string combinations keep the complete earlier admin layout. Earlier `shared/hub-owner.css` with all new modules still passes full journeys, overflow and phone taps. No JavaScript or API responses are fabricated. Only the retained static blob is replaced.
- Clean alpha sync to `54c8275d`: all five own product blobs unchanged; 242/242 focused plus changelog tests, both type checks and a fresh two-case/25-check browser control pass. The full eight-case PNG set remains one pre-sync run.
- Stock Hub style gate: 314 PASS checks. Its rig has no company-join feature, so it covers the existing shell and other Hub pages. New access-card tap sizes/overflow are checked by the real candidate browser matrix above.
- Focused suites: 167/167 across eight files, both source and test type checks pass. Restoring the five earlier product files makes 8 of the 11 new tests fail. Nine isolated mounted-unit guard reversals fail collected assertions; three retained-module guard reversals fail the owned-browser compatibility contract. The missing-company-component mark is caught by failure to restore the legacy group entry; the other two fail the explicit earlier-entry assertion. All originals restored.

The browser rig uses the real sealed Hub HTTPS/WSS listener, real configured-admin session, CSRF and production AD driver against a private recorded LDAPS peer. A connector redirects only that fixture's explicitly configured loopback LDAPS port. Clipboard text is checked against the actual server response; no API replies, session identity, group decision or authority are substituted. It creates only explicit synthetic invitations/manual offers, not connected Fleets or credentials. Each receipt confirms browser, Hub and fake-directory cleanup. There are no real directory/account/native/model/CLI/pilot operations.

## Reproduce

Use an owned Playwright installation and Chromium binary, plus a CJK-capable fontconfig. From this checkout:

```sh
npm test -- tests/hub-admin-entry-ui.test.ts tests/hub-company-join-ui.test.ts tests/hub-groups-ui-s89.test.ts tests/hub-ui-s3c.test.ts tests/i18n-ui-literals-2390.test.ts tests/ui-css-literals-ratchet.test.ts tests/hub-shared-modules-a.test.ts tests/named-link-test-2906.test.ts
npm run typecheck
npm run typecheck:tests
REPO="$PWD" PW_DIR=/owned/playwright/node_modules CHROME=/owned/chromium FONTCONFIG_FILE=/owned/fontconfig.conf OUT="$PWD/.artifacts/admin-full" MATRIX=full node --import tsx scripts/manual/hub-admin-entry/accept.mts
```

Run `BEFORE=1` with `REPO` pointing to an owned baseline checkout for the earlier layout. `MATRIX=quick SKEW=old-panel` selects desktop EN and phone zh-TW; other values are `old-company`, `old-words`, `old-owner-words`, `old-css`. Run `BROWSER=1 node scripts/manual/hub-admin-entry/verify.mjs` with the browser environment set, alone while no test/browser/type job reads the modified files; it restores every original in `finally`.

This PR changes no schema, credential, enrollment, limit or permission check. Reverting its UI commit restores the earlier admin layout without changing saved policy, invitations, pairing offers or Fleets. The digest-first manifest covers only this PR's files and committed evidence, excluding itself.
