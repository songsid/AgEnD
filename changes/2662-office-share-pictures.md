---
section: Fixed
---
- **Office share links on All offices load every room's pictures (#2662).** With full skin packs, a link opened on All offices got "too many requests" for most pictures, and those rooms stayed without their background until reloaded.
  - A pack's pictures no longer count toward the link's 120 requests a minute. They have their own limit: twice what the shown packs hold, each minute.
  - The link sends only the character sets the people shown wear.
  - A picture refused while several people open the link at once loads by itself after the wait the link names, instead of staying blank.
