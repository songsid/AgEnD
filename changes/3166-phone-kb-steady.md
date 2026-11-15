---
section: Fixed
---
- Phone chat: while you type, the screen no longer flickers and re-aligns on every key. A keystroke can make the browser report the view at a different height for a moment. AgEnD took that as the keyboard going down and up again, so the message box jumped on each key. That was most visible since 2.4.0-beta.4, which keeps the space for the home indicator under the box when the keyboard is down. Now, while the box has focus, the keyboard only counts as down once that reading holds, and until then the screen stays where it is.
