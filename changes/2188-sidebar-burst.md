---
section: Fixed
---
- **Click down the sidebar as fast as you like (#2188).** Clicking several chats in a row could leave the page stuck for seconds, and every switch felt slow. The cause was mostly the effects code: with nothing to play, it still checked the whole page's styles on every change (each status update, each click, every mouse move). Now:
  - With no effect placed, that check doesn't run at all; the dialog check runs once per change instead of several times.
  - The highlight and header follow the last click at once (at a 4× slower CPU: about 70–150 ms, from 220–1,100 ms).
  - A chat you only pass on the way isn't kept and doesn't push out the chats you use, and its history read is dropped.
  - Switching back to a kept chat no longer lays the whole conversation out twice.
