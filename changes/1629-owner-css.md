---
section: Added
---
- **Web: your own custom CSS (#1629).** **Settings → Web appearance** holds a stylesheet that applies only to your own screens, on every device where you are signed in.
  - It never applies on Settings, the sign-in page, a temporary public link or the anonymous `/view`.
  - **Save and try:** each saved version is on trial. Choose **Keep** within 15 seconds or it reverts on its own, even if the tab is closed.
  - It can't load anything from the internet. Pictures and fonts go under **Assets** (metadata removed) and are named `url("asset:<id>")`. Imports, script URLs and the riskier CSS functions are refused at save time, with the reason.
  - The last five versions are kept. A per-device switch turns it off on one browser, and `?safe=1` loads any page once without it.
