---
section: Fixed
---
- **Web chat: after a restart, the public link no longer downloads the whole chat history every 5 seconds (#1577).** With history kept across restarts (#1565), a page that polls (the public link, or the local page while its live connection is down) was sent all of the restored messages again on every poll, until someone said something new — about 1 MB each time for a busy chat. Now each page gets the restored history once, and then only what is new.
