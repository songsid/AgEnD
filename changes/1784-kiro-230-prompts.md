---
section: Fixed
---
- **kiro-cli 2.30.0: AgEnD answers its reworded Classic nudge again (#1784).**
  - 2.30.0 renamed "3.0" to "V3" in kiro's launch prompts. AgEnD no longer recognised the Classic deprecation nudge that a legacy (Classic) instance meets at launch: it neither answered nor held it, and the instance took no messages until someone answered it by hand.
  - AgEnD now answers it as before: one step off "Switch to V3", then "Remind me later", with the cursor checked before each key. Nothing changes your engine.
  - The reworded V3 prompt ("You're using Kiro CLI V2. Switch to V3 today.") and agent-config prompt ("still in the V2 format") are answered "Remind me later" and "Not now" the same way. "Don't ask again", or a cursor AgEnD can't read, is still left for you.
