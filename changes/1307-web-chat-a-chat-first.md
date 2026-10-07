---
section: Added
---
- **Web chat: a chat-first layout, light and dark (#1307, layout part).** The conversation is a centred column with
  your messages as bubbles on the right and agent replies across it (each with Copy); code blocks show their language,
  with Copy and Wrap, and fold when longer than 30 lines; the view follows new messages only while you are at the
  bottom, with "↓ N new" when you are not; while the agent works the composer's Send becomes Stop (Send comes back
  when you type). The sidebar can be hidden (remembered) and is a drawer on a phone. The dashboard follows the
  device's light or dark setting, or a per-browser choice (`/assets/theme.js` sets it before the page paints), uses
  the system font stack, and has no inline `style` attribute left (#1300).
