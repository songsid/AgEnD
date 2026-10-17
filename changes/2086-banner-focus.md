---
section: Changed
---
- **Web: an identity card's banner keeps its best part in view (#2086).**
  - **A safe band:** a banner is never drawn wider than 5 : 1. On a wider screen it is centred over a blurred copy of itself. So a 1600×600 banner always shows at least 53% of its height (a 1600×320 strip), where it once showed as little as 17% on a 2560-px screen. A phone shows 89%.
  - **Banner focus:** choose which part stays in view. A person uses the slider in View's **Edit profile**, which previews the band every screen keeps and a phone's. The agent uses `card.bannerFocus` (0 top … 100 bottom), and General uses `set_web_settings { what: "banner_focus" }`. A person's choice wins; the default is the centre, as before.
  - **For agents:** the `web-appearance` skill and the docs give the size to make (1600×600) and the safe band. `preview_web_appearance` crops the banner at its focus.
