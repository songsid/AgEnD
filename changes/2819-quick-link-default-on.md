---
section: Upgrade Notes
---
- **Web authority over the temporary public link is now on by default (#2819).** An admin signed in over the link `/web` opens can press **Authorize this browser** and confirm it in their DM, as on this computer. Nothing is granted by the update itself: every browser still needs its account's Confirm. On the first start after updating, a fleet that never set the option ends the web authorizations given so far once, so each browser confirms again. To keep it off, set `web.verified_authority.quick_link: false`, or untick **Also over the temporary public link** in Settings → Access & security → Web authority on this computer. "Only this computer can authorize" still wins.
