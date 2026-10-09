---
section: Fixed
---
- **Web app: on a web-only fleet, a turn that ends without a reply is now caught (#1515).** Messages sent from the web chat to a fleet with no Discord or Telegram connection never armed the reply-completion guard, so an agent that answered in plain text left the chat silent. They now get the same single reminder as platform messages.
- **Web app: clicking another instance keeps the sidebar where it was (#1515).** In View, the instance list jumped back to the top on every click; in both View and Chat, the active instance is now kept in view without moving the list otherwise.
