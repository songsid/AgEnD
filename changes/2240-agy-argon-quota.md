---
section: Fixed
---
- **The Antigravity (agy) usage row keeps Gemini 4 Argon's quota apart from Gemini (#2240).** On paid Pro plans Argon has a separate quota. AgEnD folded anything named "Gemini" into one Gemini line, so Argon's limit would have been hidden behind the other Gemini models. Now:
  - when agy's quota summary reports an Argon group, it gets its own line, "Gemini 4 Argon (weekly)", with its own percentage and reset time;
  - when only Argon's models report a quota, the line is "Gemini 4 Argon", showing the busiest Argon model (no window is assumed).

  The quota checks AgEnD can make have not returned Argon for the account tested so far, so this is support for when they do, not a reading already shown. The row also reads Google's main quota server first, so the Gemini line shows its five-hour and weekly limits instead of the busiest single model.
