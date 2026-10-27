---
section: Changed
---
- **A beta install is never told to switch to the stable release (#2775).** Beta users stay on beta. The daily update notice picks nothing for a beta install when only a stable is newer. When `agend update` stops rather than go back to an older version on the install's own channel, it now says that channel has nothing newer and the install is already current, without suggesting `--stable`. `agend update --stable` still works when you ask for it. An alpha install is still told about a stable that passed it, as before.
