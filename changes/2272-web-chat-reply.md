---
section: Added
---
- **Reply to a message in the web chat (#2272).**
  - **How:** hover a message for **↩** or right-click it (Reply / Copy text / Copy link). On a phone, swipe left on it (as in Telegram) or long-press it; with a keyboard, press **R** on a focused message.
  - **The composer** shows a bar with who and what you're answering (**✕** or **Esc** cancels). The sent message shows the quote, and clicking it jumps to the original.
  - **What the agent gets:** `(reply_to: "…")`, exactly as from a Discord or Telegram reply, so agents need nothing new. The server reads the quote from the original message: one line, at most 500 characters. A message the chat no longer keeps, or one a guest can't see, can't be replied to.
  - **The Discord/Telegram copy** quotes the original only if it was already in that channel; a web-only one is only named.
  - **Nothing new is granted** to guests or the public link.
