---
section: Fixed
---
- **Typing with an IME (Zhuyin, Pinyin, kana…) no longer makes the candidate bar flicker on every keystroke (#2478).** In Safari on iOS, each composing keystroke made the chat box shrink and regrow, and on a compact keyboard it took the bottom tabs out and back. That made the IME redraw its candidate bar every time. Now, while an IME composes, nothing on the page changes: the box keeps its size, the draft and the Send button wait, and the bottom tabs stay as they are. The composed text is taken once, when the IME commits it. Once the keyboard is up, it now stays up while you type. Only leaving the box, or putting the keyboard away, takes it down.
