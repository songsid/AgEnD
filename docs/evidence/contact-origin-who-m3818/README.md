# M-3818: who can clear a retained origin, and the clear path in the mixed refusal

Base `fcec01c14` (release/2.3.5-alpha).

What changed:
- **Permissions → Retained origin**: a viewer who sees the card without the Clear control is now told who has it:
  "Only this agent's managing admins (…) or the verified host operator can clear it." The names are the server's
  `eligibleApprovers` (the agent's managing admins); with none, "Only the verified host operator can clear it." Nothing
  shows for a manager (the button is there) or for an empty origin (nothing to clear).
- **contact.refusedEarlier** (several known people, or a non-admin): names the way out as `contact.refusedUnknown`
  already did — Clear retained origin on the holding agent's own Settings → Permissions, not on the page of a room that
  forwarded to it. Needs you's request card already named it for both reasons (`requestRecoveryNote`).

Captures: the real web server in an owned scratch home (the M-3366 fixture, `scripts/manual/contact-origin-who-m3818/browser.mts`),
headless Linux Chromium, synthetic roster and people. No Fleet, CLI, account or external service. The host sign-in is
the host operator, who manages every agent, so the *viewer* case keeps the real server answer and only turns
`canManage`/`canClear` off and names two synthetic managing admins. That is what a room admin who doesn't manage the
agent sees. The script asserts the button/note, the exact text, no horizontal overflow, no page or CSP errors
(`result.json`).

| Case | Manager (button) | Viewer (who can clear) |
| --- | --- | --- |
| Desktop, light, English | [manager](desk-light-en-manager.png) | [viewer](desk-light-en-viewer.png) |
| Phone, dark, zh-TW | [manager](phone-dark-zh-TW-manager.png) | [viewer](phone-dark-zh-TW-viewer.png) |

Tests: `tests/web-contact-origin-clear-3366.test.ts` (who-note in both locales: named admins, host only, none for a
manager or an empty origin; reverting the render fails 2 cases) and `tests/contact-refusal-copy-m3818.test.ts`.

Overlap: #4497 (M-3736 J) gates the Clear button on the same-card host being off. Whichever lands second should show
this note only where the button would be offered (`clearOffered && !canClear`).
