---
section: Added
---
- **Web chat: phones, keyboards and screen readers (#1307, mobile + a11y part).** On a phone the on-screen keyboard
  resizes the page instead of covering the composer (`interactive-widget=resizes-content`), the layout keeps clear of
  the notch and home bar (safe-area insets), and the composer's text is 16px so iOS does not zoom. Esc stops the
  agent's reply while it works (not while a form or menu is open, not mid-IME). The sidebar's rows are reachable by
  Tab and open with Enter/Space; the phone drawer keeps focus inside and returns it to ☰ on close. The message list
  is a log that is not read out message by message; one polite status line announces the coarse events (started,
  finished, replied, waiting for your input).
