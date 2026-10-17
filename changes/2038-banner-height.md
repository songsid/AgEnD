---
section: Fixed
---
- **Web: an identity card's banner is no longer a thin strip (#2038).**
  - **Before:** its height was half the card's size, whatever the width. In a chat header that was 48 px across the whole chat, so a 1600×600 banner showed as a sliver.
  - **Now:** its height follows the card's width, at 4:1 for S, 3:1 for M and 2.25:1 for L, kept between a minimum and a maximum for each size. In a desktop chat header, M is about 200 px; on Details and in View, M is about 240 px. The picture fills the space, cropped about its middle.
  - The chat header's card now follows the card size you chose for that agent too, and an agent's `preview_web_appearance` draws the banner at the page's height.
