---
section: Added
---
- **Send web sign-in notices and daily tips privately (#2580).** Choose `"dm"` for `web.notify_login` or `defaults.tips`, or use the three-way Settings controls. Failed DMs and missing accounts fall back to the original topic; existing fleets keep their current behavior. New fleets default sign-in notices to DM, while tips remain on in General. Public-link and guest notices go to the responsible admin, never the guest.
