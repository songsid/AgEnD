---
section: Added
---
- **Authorize this browser (#1939, step 2b).** A signed-in fleet admin's browser can now be authorized to speak as their own Discord or Telegram account. Agents still treat web messages as recognition only for now.
  - **The line under the composer** (and in the session menu) says *Not verified · Authorize this browser*. Pressing it sends a card to the account's DM: which browser (device, this computer or the network), when, and until when.
  - A card not confirmed within 5 minutes is marked expired on the card itself, and the line offers *Authorize this browser* again.
  - **Confirm** within 5 minutes and the browser is verified for `max_session_hours` (default 48): its messages carry the account's authority in their delivery receipt. **Not me** signs that browser out, also later from the same card.
  - **Guards:** one card waits per browser, 3 an hour per account, the session is checked again at the tap, and only that account can press the buttons.
  - **Not available** on the public link, for a guest, or when the switch is off: the line says why.
