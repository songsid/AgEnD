---
section: Fixed
---
- Phone chat (iPhone): typing no longer makes the message box flicker. The 2.4.0-beta.5 fix stopped the keyboard from counting as down on every key, but the page still followed every smaller change the phone reported while you typed, such as the word-suggestion bar or a few pixels of scrolling, so the box still moved on each key and back. The box was also measured again on every key. Now, while you type, the page only moves for a change that lasts, such as a new keyboard or turning the phone. The box is measured again only when the text needs a new line or you delete some.
