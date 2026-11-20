# R1: target card and command dismissal

The phone Card action now opens the selected Agent's existing `IdentityCard` in a shared Dialog. It does not toggle the browser-global preference for the current chat's card. The [one new real-app original](phone-dark-zh-TW-target-card.png) shows Beta's card while Alpha remains selected behind it. Both use distinct synthetic card text. The original context-menu appearance is unchanged; its 16 originals carry over.

Command presentation uses the same model-picker predicate as `CommandCard`. A model picker owns its own Dialog rather than being nested inside an extra sidebar Dialog. Deleting/dismissing the target command removes its surface and closes the sidebar phase. Closing a generic command Dialog also dismisses that target command before closing the phase, so a held response cannot recreate the surface. Other agents' command state and the current chat remain untouched.

Focused evidence:

- With the corrected raw `/api/card` fixture, the original submitted source produces four assertion failures and one positive in the five new cases: wrong global card preference, nested model dialogs on Close/Escape, and the blank backend result modal. The earlier malformed card fixture's TypeError is excluded from this proof.
- `npx vitest run tests/sidebar-context-menu-r1-m3485.test.ts tests/sidebar-context-menu-m3485.test.ts tests/web-chat-1307.test.ts tests/web-chat-menus-2959.test.ts tests/web-pins-ui-m3271.test.ts`: **59/59**.
- `npx tsc --noEmit -p tsconfig.test.json`: exit 0. Changed JavaScript parses; whitespace checks pass.
- Earlier CI run 44756984824 failed its shard 4 static row-markup assertion. The actual failed-job log was inspected; the assertion now allows the exact context-handler spread while still requiring a native link. That suite is included above. No CI retry was used.
- Only the newly changed target-card view was rehearsed in the real scratch app: one touch-emulated phone case, existing cookie/HTTP/SSE/UI, synthetic cards, unchanged URL, correct Beta content, Escape/focus return, no browser errors/CSP violations/unexpected writes. The new original was visually inspected. No provider command, real account, physical phone or native CLI ran. Command lifecycle proof is mounted/stubbed, not a live provider campaign.

The global card preference, target command identity, one-Dialog model presentation, Close/Escape/result dismissal and a held response are exercised by actual mounted components. No broad source, mutation, browser or native campaign was repeated. The PR remains draft under the visual hold; rollback remains UI/skill only.
