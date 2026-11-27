# M-3820: contact cards decided elsewhere are deleted, not edited

Base `fcec01c14` (release/2.3.5-alpha).

**Before:** when a request was approved, declined or expired somewhere else, every other card for it stayed in General,
edited to 「已在別處核准（網頁或另一張卡片）」 / "Approved elsewhere (the dashboard or another card)." Somewhere else
means the web, another card, or General's proposal. The user's 11-26 screenshot shows two such cards at 21:51.

**After:**
- **Cards for a request decided or expired elsewhere are deleted** from the channel. This covers the M-3680 held card,
  slice K's same card, and General's proposal card for the same request.
- **The card a person pressed is never deleted.** It keeps its outcome line ("Approved once by …", "Continued by …").
- **The decision stays in the agent's Settings → Permissions history.** The web's open prompt still hears the outcome.
- **One delete attempt.** If the platform refuses it (Discord Missing Permissions, a Telegram message over 48 h old, a
  gateway not ready), the card falls back to the edit it had before. There are no retries.
- **A card whose own timer ran out while the request still waits** is edited to "This card expired…" as before. That
  card says where the request can still be decided.

Tests (synthetic adapter, the real FleetManager posting, callbacks and retirement):
- `tests/contact-held-card-m3680.test.ts`, the M-3820 cases:
  - decided elsewhere: deleted, the web is told, and a late click does nothing;
  - a refused delete makes one attempt, then edits;
  - the pressed card keeps its outcome;
  - decided while the card was still posting: deleted once it posts.
- `tests/request-contact-native-s229.test.ts`, the M-3820 cases:
  - a decision on General's proposal deletes the held card;
  - a decision on the web deletes every native card.
- Turning deletion off fails 5 of these.
