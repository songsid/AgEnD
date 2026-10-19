---
section: Fixed
---
- **Custom CSS General saves for you no longer goes back before you can answer (#2198).** The 20-second keep window started when General saved it, but your "keep it" comes back through chat (about 40 seconds), so General's keep always failed. Now:
  - The version waits until you open the dashboard (up to 10 minutes), and the 20 seconds start once it's on your screen. CSS that hides its own Keep button still reverts.
  - If "keep it" arrives after the 20 seconds, General puts that version back in force.
  - A version you save yourself on the Settings page works as before.
