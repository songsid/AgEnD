---
section: Fixed
---
- **Closing the Sign in dialog before the terminal is opened ends the background sign-in (#3212).** Adding a named account opens the Sign in dialog and starts a background sign-in that lives ten minutes. Closing the dialog only hid it, so for those minutes the account stayed "signing in" and could not be removed. Close, ×, Esc and Cancel sign-in now end it, but only when it is your own, still running, and its one-time terminal code has not been used; a sign-in that is under way in the terminal is never cut off. The server checks all of that again when it ends the sign-in, for that sign-in only: a Close that arrives late never ends another admin's newer sign-in or a terminal that has been opened since.
