# S-272: Settings → Access & security before the first turn-on of request-based contact approvals

These are real-app captures from the M-3864 rig: release-line build 2.4.0-beta.2702 running as the user's systemd service in a scratch container, with mock agents. The dashboard was loaded in a headless browser.

- **This change's code.** This branch's `request-context-control.js` is served in place of the shipped one.
- **The server's answer.** Only `GET /api/settings/request-context` answers with the view this branch's controller now gives before the first attempt: `attempted: false`, `phase: "blocked"`, and three blockers:
  - an earlier pending request (R39dd137e);
  - an earlier approved request with no readable delivery record (R7a01c2f4);
  - two busy agents (m1, m2).
- **Variants:**
  - **Desk light en:** 1280×860.
  - **Phone dark zh-TW:** 390×844 at 2×, with the host's language preference set to zh-TW for the run and then set back.

Before this change, the same fleet showed "Not enabled. Contacts haven't changed." with no blockers until an On was attempted.
