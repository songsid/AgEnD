---
section: Security
---
- **Web: a guest's browser can ask for a new sign-in code, as an admin's can (#1920).**
  - **How:** after a guest signs in, their browser is remembered. Next time, the sign-in page offers to send them a fresh code. It goes to them privately by DM, under the same rules as their `/web`: at most once a minute, and only while they're still a guest with agents to see. It works on the dashboard reached directly and, while an admin has it open, through the public link.
  - **Admins' devices are safe:** guests' browsers are counted separately (4 per guest, 64 in all), so a guest never pushes an admin's remembered browser out. Guests' code requests have their own limits too, so they can't use up the admins'.
  - **Forgetting them:** a guest's `/web revoke` forgets their own browsers. Turning `web.guests.enabled` off forgets every guest's. An admin's `/web revoke` still forgets everyone's.
