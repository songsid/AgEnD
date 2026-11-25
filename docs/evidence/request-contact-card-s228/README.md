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

Script: `scripts/manual/request-contact-card-s228/capture.mts`. It ran at `fe4aa6613` (`src` clean) and passed 116 of 116 checks. `receipt.json` lists the commit, every check, and each PNG's sha256.

| Frame | What it shows |
|---|---|
| 1-needs-unverified | Needs you, before this browser is verified. The request is a standard Needs-you item, not a raised card, in the style used for the usage-credits card:<br>• title: "Front desk wants to contact Billing";<br>• one detail line with the reason and this card's scope in a few words: "This was sent while Front desk was working on Alex's request from a restricted room. Continue = this request and its follow-up contacts only.";<br>• the rest folded under "What it asks", with the full scope wording;<br>• the buttons (Continue (approve once), Always allow…, Decline) off, with one line, "Authorize this browser to decide.", and **Authorize this browser** inline.<br>There is no count-only line. |
| 2-verified | After Authorize this browser and the account's confirm, the card is read again and its buttons are on, and so is every other card on the page: one Authorize serves them all. The scope phrase never breaks at its 「＝」 or "=". Verifying (and Enter) decided nothing: the request is still pending, and nothing was admitted. |
| 3-continued | One click: the item says "Continued" in its detail line and has no buttons. The request was admitted once. |
| 4-authorizations | Fleet → Authorizations, Waiting: a guest's request ("Continue = this request and its follow-up contacts only.") and a legacy one ("Approve once = this one request only.", with the button Approve once). Each card's detail line explains its own verb. There is no Clear retained origin. |
| 4b-details | The legacy request's details folded out: the message, "No single known person asked", "Approve = forward this request once.", the times and its id. |
| 5-always-allow | Always allow… on the legacy request. Its rule lists the request's people from the card's server-owned grant candidates. Opening it decides nothing. The dialog is the existing grant editor (M-3544); its phone layout is carded separately. |

The matrix is desk light en, desk dark zh-TW, phone light en and phone dark zh-TW. The phone checks cover the buttons being at least 44 px and no sideways scroll.

Not captured: Permissions with Clear retained origin shown as history. The fixture's agents have no retained origin, so that section isn't drawn. `tests/web-request-contact-card-s228.test.ts` covers it for the on, off and unknown host states.
