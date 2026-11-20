# Office speech bubble → chat window

The initial popup behavior was approved; the user then requested the two existing overlaps fixed in the same PR. [R1](r1/README.md) supersedes the layout limitations and captures below. These original files remain as before evidence.

A private Office speech bubble now opens the existing authenticated chat in a separate window. The Office stays open. The child reads its own session and history; no draft, conversation content or credential is handed across. The native desk button → agent card → Chat path is keyboard reachable and announces the new window.

Floating targets follow the actual painted text, final collision displacement, zoom and overview tile transform. Phone taps get a 44 CSS-pixel effective target; the phone smoke taps 15px below the tiny painted bubble. A double-click on a bubble opens only one window. Ordinary person/card interactions stay available.

The guard refuses guests, read-only shares without the server capability, ended sessions and absent or unsafe agent names before opening anything. Server chat admission and send permissions are unchanged. Popup blocking uses the existing translated notice and retains the source.

## Originals

Each desktop EN/light and phone zh-TW/dark set has:

- *-office.png: source Office with a synthetic dialogue.
- *-chat.png: authenticated child, synthetic history and an unsent draft.
- *-keyboard.png: native agent-card Chat action focused.
- *-bubble.png: the floating bubble used for the actual click/tap.

All eight PNGs are originals from the headless real app on a disposable host. No Fleet, model, real account or provider CLI was started, and no chat message was sent. The helper's persistent stuck state is synthetic, keeping its bubble visible across stream refreshes.

The phone's existing room dock overlaps the lower-left dialogue area. This change adds no layout or CSS. The clear right side and floating bubble are exercised. That overlap remains outside this change.

## Checks

validation.json records 283 passing tests across 13 files, test TypeScript exit 0, the fail-first controls and both browser cases. The phone case uses actual touch events and the expanded bubble target; the native keyboard path is also exercised in both sizes. Existing share-page, pop-out composition, phone-query, asset-cache and shell parity contracts pass.

Run with the normal smoke fixture environment:

    npx tsx scripts/manual/smoke/smoke-office-chat-m3464.mts

The earlier fixture attempts were corrected to open the existing phone overflow menu, await the subscription/entrance animation and use a persistent fixture state instead of one overwritten by the live scratch stream. No production workaround, retry or deadline extension was added.

Limits: these are synthetic app and stubbed-guard proofs, not a live provider, guest sign-in or OS window-manager campaign. Rollback is a revert of the presentation/test change; there is no stored-data or configuration migration.
