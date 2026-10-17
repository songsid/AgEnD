---
section: Changed
---
- **Web: an identity card's banner keeps its best part in view (#2086).**
  - **A safe area:** a banner is never drawn wider than 5 : 1 (on a wider screen it is centred over a blurred copy of itself) nor narrower than 9 : 4. So every card, on every screen and layout, shows the middle 84% of the width and 53% of the height of a 1600×600 banner (a 1350×320 area). Before, it could show as little as 17% of the height on a 2560-px screen. A phone's medium card shows 89% of it.
  - **Banner focus:** choose which part stays in view. A person uses the slider in View's **Edit profile**, which previews the band every screen keeps and a phone's. The agent uses `card.bannerFocus` (0 top … 100 bottom), and General uses `set_web_settings { what: "banner_focus" }`. A person's choice wins; the default is the centre, as before.
  - **For agents:** the `web-appearance` skill and the docs give the size to make (1600×600) and the safe band. `preview_web_appearance` crops the banner at its focus.
