---
section: Upgrade Notes
---
- **The first start on 2.2 tells General about web chat, once (#1366).** Each chat platform's General gets one short
  message: what web chat is, that it is the same conversation as the topic, and that `/dashboard` signs you in. It is
  recorded in `~/.agend/upgrade-notices.json` and never repeats; a platform with nowhere to post fleet notices is told
  once it has one. A message that fails to send is tried again at the next start.
