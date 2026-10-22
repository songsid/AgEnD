---
section: Fixed
---
- A guest opening a page that is not theirs (Fleet, Settings…) in the browser now sees a page in the browser's language, with a way back to the chats shared with them, instead of the bare `guest_forbidden` / `guest_scope_empty` JSON. A guest with no chat shared any more is told so. API callers still get JSON.
