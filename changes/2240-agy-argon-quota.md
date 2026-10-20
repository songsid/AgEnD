---
section: Fixed
---
- **The Antigravity (agy) usage row keeps Gemini 4 Argon's quota apart from Gemini (#2240).** On paid Pro plans Argon has a separate quota. AgEnD folded anything named "Gemini" into one Gemini line, so Argon's limit would have been hidden behind the other Gemini models. Now:
  - when agy's quota summary reports an Argon group, it gets its own line, "Gemini 4 Argon (weekly)", with its own percentage and reset time;
  - when only Argon's models report a quota, the line is "Gemini 4 Argon", showing the busiest Argon model (no window is assumed).

  The row asks Google's quota server exactly as agy's own CLI does (the same client name and version agy 1.4.3 sends), so on a paid plan it shows what agy's `/quota` shows: the Gemini line with the plan's own five-hour and weekly limits (not the busiest single model or a free-tier figure), and Gemini 4 Argon's weekly limit on its own line.
