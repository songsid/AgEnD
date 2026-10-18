---
section: Added
---
- **Authorize this browser (#1939, step 2b).** A signed-in fleet admin's browser can now be authorized to speak as their own Discord or Telegram account. Agents accept its messages as the person from step 3.
  - **The line under the composer** (and in the session menu) says *Not verified · Authorize this browser*. Pressing it sends a card to the account's DM: which browser (device, this computer or the network), when, and until when.
  - A card not confirmed within 5 minutes is marked expired on the card itself, and the line offers *Authorize this browser* again.
  - **Confirm** within 5 minutes and the browser is verified for `max_session_hours` (default 48): its messages carry the account's authority in their delivery receipt. **Not me** signs that browser out, also later from the same card; when the authorization ends, the card says so. Times on the card show the host's time zone, and its end is the session's own when that comes first.
  - **Guards:** one card waits per browser, 3 an hour per account, the session is checked again at the tap, and only that account can press the buttons.
  - **Not available** on the public link, for a guest, or when the switch is off: the line says why.
