---
section: Fixed
---
- **A delivery's Enter is never pressed into a dialog that appeared after the paste, and never into a restarted CLI.**
  - **The dialog case.** A permission card, a dangerous-command card or another dialog the agent's CLI shows (that AgEnD recognises) can appear between pasting a message and pressing its Enter. That Enter would have answered the dialog. The pane is now read once more right before the Enter. With such a dialog on screen, the Enter is withheld, the delivery is marked uncertain in Needs-you, and the dialog waits for a person.
  - **Anything else still sends.** A screen AgEnD cannot read, or does not recognise, still gets the Enter exactly as in beta.5, so the beta.4 problem where Codex's composer was not recognised cannot return.
  - **The restart case.** The wait for a pane left in copy-mode (up to 10 minutes) no longer lets the Enter reach a CLI that was restarted meanwhile. (M-2290, #2985 follow-up; the simple half of #2957)
