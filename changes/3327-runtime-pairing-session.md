---
section: Security
---
- **Pairing a Windows computer needs the dashboard page.** Creating a pairing code and approving a computer now need an administrator signed in on the dashboard, using the page's own **Connect a computer** and **Approve computer** buttons. A raw API call carrying only the `X-Agend-Token` header is refused, so it can no longer pair a computer by itself. You click the same buttons as before, and no step is added.
- **A sign-in code is only issued on the AgEnD computer itself.** The host's code request (`agend web`) now answers only a direct request from this computer. With the web token alone, a remote client or one behind a proxy can no longer get an admin session. You can still type the printed code into a browser anywhere.
- **The threat model is now written down.** AgEnD defends against remote parties, other users of the computer, visitors over the public link, guests and cross-site requests. A program running as the fleet's own OS user counts as the owner. See [SECURITY](docs/SECURITY.md#threat-model).
- **Authenticator changes are announced.** On a web-only fleet, setting the authenticator app up again, or removing it, now posts a notice, so a change you didn't make is noticed.
