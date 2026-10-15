---
section: Fixed
---
- **Web: uploading a View picture no longer deletes another instance's picture (#1630 follow-up).** An upload used to delete every stored avatar whose name began with the instance's name and a dot. So uploading for `a` also removed `a.b`'s picture. Instance names may contain a dot (the Settings quickstart allows it, and so does a hand-edited `fleet.yaml`). Now an upload replaces only the file that instance's own profile records.
