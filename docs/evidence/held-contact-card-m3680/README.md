# M-3680 part 2: a held fleet agent's send, approvable from General

A chat card is a Discord or Telegram message, not a dashboard page. This evidence is therefore the card as the actual `FleetManager` posts it, with each outcome, from `tests/contact-held-card-m3680.test.ts` (`M3680_CARD_EVIDENCE=<dir>`). The adapter, people and contact store are synthetic, and there is no platform connection. The ticket id is shown as `#R12345678`; nonces are left out.

- `en.json`, `zh-TW.json`. Each has:
  - **approve**: the posted card (four lines, two buttons) and, after an approver clicks Approve once, the card's last words and the request's state (`approved`);
  - **classicRoomApprove** (R21079937, the stacked follow-up): a ClassicBot room's request to a fleet agent. It gets the same card, with the room named by its display name, and is approved the same way;
  - **decline**: the same for Decline (`declined`; the agent is told by the existing outcome notice);
  - **notAllowed**: someone who may not decide it clicks; they are told so, nothing is decided, and the card keeps waiting;
  - **decidedOnTheDashboard**: the request is decided on the web; the card is retired and says so;
  - **expiredText**: what the card says when its buttons expire.
