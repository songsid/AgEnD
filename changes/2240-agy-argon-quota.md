---
section: Fixed
---
- **The Antigravity (agy) usage row keeps Gemini 4 Argon's quota on a line of its own (#2240).** On paid Pro plans Argon has a separate quota. AgEnD folded anything named "Gemini" into one Gemini line, so Argon's limit would have been hidden behind the other Gemini models. It now gets its own line, "Gemini 4 Argon (weekly)", with its own percentage and reset time, whether agy reports it as a group or per model. The row also reads Google's main quota server first, so the Gemini line shows its real five-hour and weekly limits instead of the busiest single model.
