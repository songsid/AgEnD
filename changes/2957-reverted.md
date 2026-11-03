---
section: Fixed
---
- **Codex messages are submitted again right after a resume and while Codex is busy (beta.5 reverts).** The pre-Enter input-box check added in beta.4 (#2958) did not recognise Codex's footer after `codex resume` or while it was working, so it withheld the Enter and messages sat unsent in the box. That check is removed, so the delivery's final Enter works as it did in beta.3. The copy-mode wait (#2971) stays. #2957 (an Enter landing on a permission card that replaced the input box) is open again.
- **The View terminal is back to its beta.3 behaviour.** The scrollback and "earlier in the log" changes (#2969, #2974) are reverted.
