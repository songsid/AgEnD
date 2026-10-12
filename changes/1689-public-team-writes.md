---
section: Security
---
- **Web: teams can no longer be created or deleted over a temporary public link (#1689).** `POST /ui/teams` and `DELETE /ui/teams/<name>` were open to public-link sessions, unlike settings. Both are now off the public link's route list, and the handlers refuse them there as well (403). The new team edit is refused in the same way. Teams can still be viewed over the public link.
