---
section: Fixed
---
- The Windows installer's setup step fits narrow console windows. The setup code is shown in a plain ASCII box only when it fits, or else on its own line, and long lines are wrapped to the real window width, counting Chinese characters as two cells. The waiting line no longer redraws while the setup page is open, so the code can be selected without flicker. A note right under the code says it is already on the clipboard.
