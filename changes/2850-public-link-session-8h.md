---
section: Changed
---
- A sign-in over the temporary public link now lasts as long as the link, up to 8 hours (it was a fixed 4 hours). It is never longer than the account's own session limit — `web.session.local` for an admin, `web.guests.session` for a guest — and still ends after 30 minutes unused or when the link closes.
