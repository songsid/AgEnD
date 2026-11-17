---
section: Changed
---
- Web sign-in: a /web code sent to you privately (by DM, in a Discord reply only you can see, or in your Telegram chat with the bot) now verifies that browser at once, with no second card to confirm. Your DM gets a "signed in" notice with Not me, which signs that browser out. Codes that weren't sent privately, guest codes and `agend web --code` on a fleet with a chat connection work as before. When an authorization runs out, the card is still how you renew it, or sign in again with /web.
- Web authority over your fixed (named) link is now on by default, like the temporary public link; `web.verified_authority.named_link: false` turns it off.
