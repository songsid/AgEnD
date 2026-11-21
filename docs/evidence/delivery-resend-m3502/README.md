M-3502: live-pane delivery recovery and an in-place web Resend

The failure log's specific preceding error is the stranded-input budget reaching round3. The later lifecycle warning called every `message_failed` event “window gone, retries exhausted”; it did not establish a missing window. The earlier quota warning had already recovered. The failure-time pane capture is unavailable, so no exact historical footer shape is asserted. Live evidence was inspected read-only; no live pane, account or Fleet was restarted or changed, and no private log or chat record is included here.

After the startup input barrier is retired by an earlier successful delivery, the broad idle gate can return ready while the stricter stranded-input check still needs a stable composer. The loop charged each busy observation against its three-key recovery budget. Its wait could resolve immediately, consuming all rounds without a timed retry. A production Codex backend with the existing context-less footer fixture and an explicitly live stubbed pane reproduces the failure before the first second. The fixed path waits between busy observations, bounds the whole wait by the existing30-minute readiness budget, charges only actual recovery Enters and allows a final clear check without a fourth recovery Enter. Cancellation remains silent; an unsafe composer is never pasted onto. Failed events/logs carry their actual phase/proof.

The server's failed-delivery state already reached web chat. The existing Retry only handled browser-local requests that failed before acceptance. The new Resend uses the retained server row, current sender and admission, quote visibility and safely reopened original files. It accepts no replacement text or paths. Normal one-use upload rules remain intact. Missing/replaced files or missing quotes leave the original bubble untouched with a localized explanation.

| Current state | Retained bubble | Delivery attempt | Needs you |
|---|---|---|---|
| Failed | Original boot/id, quote and files | Failed attempt | Listed |
| Resend queued/processing | Same row, no new message event | Fresh wire ID, synchronously claimed once | Still listed |
| Current attempt confirmed | Same row | Delivered | Clears |
| Late old report | Same row | Ignored | Cannot clear the current episode |

Two tabs cannot claim the same failed attempt twice. Losing the HTTP answer after handoff does not create another send or turn acceptance into failure. Current session/instance admission is passed through the same human-delivery facade. Guests keep their current scope/chat/command rules, the public gateway explicitly routes Resend through its existing gate, and current public raw-command restrictions remain. Retry ownership is the server's account key, never a display-name comparison or client assertion.

New owned failed-delivery descriptors keep their attempt/attention state through history reloads; legacy rows still do not acquire unverified interactive state. Malformed or mismatched descriptors are refused. Stable web attention IDs share the existing bounded24-hour/newest50 delivery projection and acknowledgement path. Attention survives queued/processing retries and clears on current confirmed delivery, or an explicit existing Acknowledge action.

Main first: main has both affected paths. The dev twin follows the actual main merge and preserves dev's workspace/native-runtime integration. This PR is on USER-LOOK HOLD; the coordinator must wait for the user's visual release and exact-head review/checks.

Validation (overlapping runs are not added together):

- Root fail-first: the retired-startup-guard live-pane case emits failure before its first timed retry on the base; fixed controls cover stable recovery, cancellation, persistent unsafe input, actual three-Enter refusal and a successful final clear check.
-20 affected files:294 passed. Subsequent focused transport/persistence controls38 passed; final guest/recovery/history controls50 passed; public-route/raw/upload controls73 passed. The new public route assertion failed before its gateway registration. Test types exit0.
- Real HTTP controls cover one claim across double taps, unchanged bubble count/quote/files, late reports, current admission revocation, missing/replaced files, missing quote, CSRF/owner refusal and a lost response after handoff. Existing request-retry deduplication remains covered.
- Chromium product-app fixture: all8 desktop/phone × light/dark × EN/zh-TW cases keep one bubble, its quote/file, no horizontal overflow, and no action-time page error/CSP report. Phone Resend targets measure44px; desktop uses the shared30px small ghost button. Needs you remains while queued and clears when confirmed. The initial30px phone target failed the capture check and was corrected before the retained captures.

Captures in [main/](main/) include four before views from baseline2af5f0a96, all eight failed-message matrix views and queued/delivered views for desktop light EN and phone dark zh-TW. Every selected16 PNG was visually inspected: generic Example identities/content only, no private names/chat IDs, no unexpected clipping or overlap. The phone's one-line quote ellipsis is also present in the baseline. These are real product pages on an owned scratch web server; pane delivery is stubbed. No physical phone, Safari, Windows runtime, live provider/account or live pane campaign is claimed. The normal render/styles did not change after the captures; later bounded controls hardened response-loss and restore/routing checks.

Shared UI: the existing chat thread, quote/attachment renderers, `.btn.btn-ghost.btn-sm`, token spacing and the canonical touch query. No additional confirmation step or new page; the sender finishes in the same chat. English **Resend** and Traditional Chinese **重新傳送** use the normal string table.

Rollback restores the delivery loop/diagnostic and removes the resend protocol/UI/projection changes. New retry fields are optional and ignored by older readers; message content/quotes/files remain normal history. No migration or runtime credential change.
