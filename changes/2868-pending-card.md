---
section: Changed
---
- **The card for a settings change that waits for confirmation now says where to confirm it (#2868).** It used to show "Confirm it on the host: agend settings confirm <id>" first, even when a confirm card was on its way to General. Now it shows, in order:
  - "Sending the confirm card to General…", then "To apply it, press Confirm on the card in General on Discord" (or Telegram, wherever the card was posted).
  - **Apply now**, when this browser is web-verified and its account may confirm the change itself (the same rule as confirming by applying). General is told.
  - **Authorize this browser**, when it isn't verified but could be. Once authorized, the waiting card offers Apply now.

  The host command moves under "Advanced: confirm on the host", unless no General could take the card.
