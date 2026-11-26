# M-3762: today's AgEnD update surfaces on the web (inventory captures)

These are from the real web app (`scripts/manual/smoke-fixture`), headless Chromium. `/ui/update` is answered with each state the page draws, in the server's own shape (`web-api.ts` `handleWebUpdate`); nothing is installed. The script is `scripts/manual/update-surfaces-m3762/capture.mts`. It ran at `592178b52` (`src` clean) and passed 20/20. The banner frames sit on Needs you, a page with nothing else on it. `receipt.json` has every frame's sha256 and the exact text each one showed.

| # | What | Files |
|---|---|---|
| 1 | The banner's offer line: Update now · Later (admins only) | `m3762-{desk-light-en,phone-dark-zh-TW}-1-offer.png` |
| 2 | Its confirmation ("Every Agent stops briefly…") | `…-2-confirm.png` |
| 3 | Settings → Advanced → Version and update | `…-3-settings.png` |
| 4 | An update running (step 2 of 4) | `…-4-running.png` |
| 5 | A failed one (the update source could not be reached) | `…-5-failed.png` |
| 6 | A finished one | `…-6-complete.png` |
| 7 | A Hub's recommendation | `…-7-hub.png` |
| 8 | A read-only session: no offer | `…-8-readonly.png` |
| 9 | A web-only fleet's "update available" Notice in Notices. It is worded once, when it is recorded, in the fleet's language, so a zh-TW viewer reads it in English. | `…-9-notice.png` |

General's topic post ("🆕 AgEnD {0} available (current: {1})! Run: /update"), chat `/update`'s progress message and the `agend update` CLI are not web pages. The design doc (`docs/design/update-adoption-m3762.md` §1.2) quotes them word for word, with their sources.
