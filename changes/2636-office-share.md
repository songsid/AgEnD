---
section: Added
---
- **Office share links (#2636):** show the live Office to people outside the fleet for a while. **Share…** in Fleet → Org chart → Office (a fleet admin, on the dashboard reached directly or over the temporary public link) makes a link anyone can open with no sign-in.
  - The viewer sees that office (or all of them), read-only: names, identity colours and who is working, idle, asleep or calling, updated every 5 seconds. No chat, settings or other pages; agents' own status lines only when you include them; hidden agents never.
  - 1 hour by default, 15 minutes to 24 hours (`web.office_share.max_hours`); at most 10 open. Each runs on a quick tunnel of its own that starts with the first link and stops with the last. Revoke them in **Settings → Access & security → Office share links**; General hears who made or revoked one.
  - When Cloudflare limits new quick tunnels, making a link says to try again in a few minutes. `web.office_share.enabled: false` turns it off.
