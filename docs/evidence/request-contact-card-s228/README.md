# M-3736 J: the web's one contact card (real app)

These are captures of the one contact card on the web. It is the same card in Needs you and in Fleet → Authorizations, on slice I's server (#4492). They were taken from the real web app (`scripts/manual/smoke-fixture`) in headless Chromium.

The script drives #4492's real objects:
- a `DeliveryOutbox` with the request-context barrier;
- its `RequestContactGate`, holding scoped requests;
- the card service (read, list, decide with the full snapshot check, and Needs you's scoped items);
- the HTTP routes.

They are installed into the fixture's FleetManager as `requestContactApi`, the way slice L will install them. Nothing is delivered anywhere: the outbox is the capture's own scratch database. Each decision goes through the real writer, and the receipt checks its effect: still pending, admitted exactly once, or declined.

Two seams are stubbed:
- **The principal.** The fixture signs in with a host code, which has no chat identity on a chat fleet, so the request's person is one fixed, recognized managing admin. It is unverified or verified per frame.
- **`GET` / `POST /ui/authorization` in the browser.** "Authorize this browser" goes from not verified to waiting to verified without a Discord DM.

Script: `scripts/manual/request-contact-card-s228/capture.mts`. It ran at `fa06a7bb6` (`src` clean) and passed 174 of 174 checks. `receipt.json` lists the commit, every check, and each PNG's sha256.

| Frame | What it shows |
|---|---|
| 1-needs-unverified | Needs you, before this browser is verified. The request is a standard Needs-you item, not a raised card, in the style used for the usage-credits card:<br>• title: "Front desk wants to contact Billing";<br>• one detail line with the reason and this card's scope in a few words: "This was sent while Front desk was working on Alex's request from a restricted room. Continue = this request and its follow-up contacts only.";<br>• the rest folded under "What it asks", with the full scope wording;<br>• the buttons (Continue (with follow-ups), Set allowed contacts…, Decline) off, with one line, "Authorize this browser to decide.", and **Authorize this browser** inline.<br>There is no count-only line. |
| 2-verified | After Authorize this browser and the account's confirm, the card is read again and its buttons are on, and so is every other card on the page: one Authorize serves them all. The scope phrase never breaks at its 「＝」 or "=". Verifying (and Enter) decided nothing: the request is still pending, and nothing was admitted. |
| 3-continued | One click: the item says "Continued" and the outcome, "Forwarded to Billing." (「已轉交給 Billing。」), in its detail line and has no buttons. The request was admitted once. |
| 4-authorizations | Fleet → Authorizations, Waiting: a guest's request ("Continue = this request and its follow-up contacts only.") and a legacy one ("Approve once = this one request only.", with the button Approve once). Each card's detail line explains its own verb. There is no Clear retained origin. |
| 4b-details | The legacy request's details folded out: the message, "Can't tell who asked" (「無法確認是誰提出的」), "Approve = forward this request once." and the times. The internal request id is no longer in view (it stays as the times line's tooltip). |
| 5-always-allow | **Set allowed contacts…** (「設定常用轉交…」) on the legacy request opens "Set allowed contacts for these people" (「設定這些人的常用轉交」). Its rule lists the request's people from the card's server-owned grant candidates; opening it decides nothing. The plain boundary comes first, under the route, and the line about ticking someone sits right under the people, so neither is behind the footer: it only decides whether a message is forwarded, and the receiving agent still follows its own permissions. The save button, **Approve this one and allow from now on** (「核准這筆，並設為常用轉交」), stays off until someone is ticked, and a line says so. The expiry is a day, then the hour and minute on one row, from selects in the page's language: no native date field, and no AM/PM on the zh page. |

The matrix is desk light en, desk dark zh-TW, phone light en and phone dark zh-TW. The phone checks cover the buttons being at least 44 px and no sideways scroll.

Not captured: Permissions with Clear retained origin shown as history. The fixture's agents have no retained origin, so that section isn't drawn. `tests/web-request-contact-card-s228.test.ts` covers it for the on, off and unknown host states.

After the leader's capture check (#4497): **Continue (with follow-ups)** (「繼續（含後續聯絡）」) is a new request's decision, and **Approve once** an older request's, so they keep different words. The grant button, **Set allowed contacts…** (「設定常用轉交…」), shares the editor's name: "Set allowed contacts for these people" or "for this person". Disabled buttons use the app's shared disabled style; the UI style guide sets no contrast rule for disabled controls.

After the leader's recheck (phone): the card's decision row wraps to a second line instead of clipping a button (a check fails if any button's words overflow), and the grant editor's body scrolls between its head and footer, so its last line clears the footer buttons (checked by scrolling to the end).

`phone-dark-zh-TW-5b-always-allow-end` is the same editor scrolled to its end: its last line, the Advanced toggle under the time zone, sits fully above the footer. On a phone the footer's buttons wrap their words inside the button instead of widening the dialog, so ui-gate's m3409 overflow check holds.
