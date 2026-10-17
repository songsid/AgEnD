---
section: Security
---
- **Web: groundwork for signing in non-admins as guests (#1920), with nothing changed for admins.** No guest sign-in code can be issued yet; that comes next.
  - **Default deny:** when there are guests, they'll reach only a fixed list of routes, checked before any handler on the dashboard and the public link alike. Anything else answers 403, and an instance outside the guest's scope answers 404.
  - **Signing out other devices:** a session that isn't an admin's now lists and signs out only its own devices. An admin's still signs out everyone.
  - **The docs say plainly who can read the anonymous `/view`:** every local user and process, whatever a reverse proxy, tailnet share or port forward admits, and on WSL2 the Windows side. They see every agent, including the live terminal. `web.view_access: session` closes it, and the default is unchanged.
