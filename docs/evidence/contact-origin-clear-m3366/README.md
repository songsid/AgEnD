# Administrator origin clear: evidence

Design reviewed at `84906ffea` before implementation; runtime baseline
`a1d9f1f98`. Scope is the first slice only. Work-item and fresh-session reset
remain design-only in docs/design/contact-origin-reset.md.

Validation (2026-11-19):
- The 16 backend regressions fail at the baseline without this feature.
- Backend/UI and contact/Hub/skill/wording neighbors: 181/181, 13 files.
- Four single reversals are caught by assertion failures: origin revision,
  incarnation fence, management recheck and atomic audit/reset. Source restored.
- Source and test TypeScript checks exit 0.
- A final narrow backend/UI run uses injected time for audit pagination.

The real web server runs in an owned scratch home with a small synthetic roster.
No Fleet, vendor CLI, account, external service or visible window is started.
The browser driver forces Linux Chromium headless inside WSL. It signs in through
the real host-code form and drives the actual authenticated clear API; neither
the Permissions response nor the clear result is mocked. Both desktop/light/EN
and phone/dark/zh-TW confirm the new known administrator origin and last-clear
audit, with no document overflow, page errors or CSP errors. A final phone-only
text check replaces the English receipt noun in the Chinese label.

| Case | Before | Confirm | After |
| --- | --- | --- | --- |
| Desktop, light, English | [before](desk-light-en-before.png) | [confirm](desk-light-en-confirm.png) | [after](desk-light-en-after.png) |
| Phone, dark, zh-TW | [before](phone-dark-zh-TW-before.png) | [confirm](phone-dark-zh-TW-confirm.png) | [after](phone-dark-zh-TW-after.png) |

UI reuses existing `.card`, `.contact-list`, shared buttons and `confirmDialog` /
`Dialog` (including its phone sheet); no new CSS frame or confirmation system.
The displayed names and identity keys are synthetic, with no generated topic
suffixes. The last-cleared actor/time comes from audit, beyond the 50-row history
page. Receipt IDs are omitted from the view and audit images; counts remain.

Rollback: revert and restart. The additive revision table/DTO/audit fields are
harmless to the older build. An administrator's already accepted origin remains
accepted; rollback does not silently restore its previous union. Audit remains.
