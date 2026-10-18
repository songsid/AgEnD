---
section: Added
---
- **Web authority: the server switch, revocation and the step-up list (#1939, step 2a).** Still recorded only: agents treat web messages as recognition.
  - **`web.verified_authority.enabled`** (default off) is the server switch. While it's off, web messages record no authority, and every web authority already recorded reads as none in `delivery_status`. Turning it back on never brings that authority back.
  - **Revocation.** `/web revoke` now also revokes every web authority given so far. Turning "Only this computer" (`loopback_only`) on makes earlier LAN authority read as none, and turning it off again doesn't restore it. `delivery_status` says why a receipt reads as none (`downgraded`).
  - **The step-up list.** `web.verified_authority.step_up.enforce` names the actions that always need a fresh confirmation from the account: release, force-push and deleting an instance by default, with seven more to pick from, plus your own under `step_up.custom`. `delivery_status` returns the list in force with every human receipt.
