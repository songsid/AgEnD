---
section: Fixed
---

- "Not me" on a web authorization card now says so when the sign-out couldn't be saved (the session file could be neither updated nor removed, so a restart might bring that browser back), as signing out on the web already did; an authorization whose end couldn't be saved is retried, and its old file is removed so a restart never restores it. (#3082)
