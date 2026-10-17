---
section: Fixed
---
- **Web: the Effects dialog says why an effect is not playing (#2055).** Instead of a bare "Stopped", each effect names its cause:
  - paused (also after a reload);
  - turned off on this device after three automatic pauses (Resume says so too, instead of "the page is not ready");
  - stopped because the page closed while it played;
  - waiting while you type, or while a menu or panel covers the chat;
  - "Was running; paused while this dialog is open" for the dialog itself;
  - custom CSS, reduced motion, data saver, previews off, a hidden tab, safe mode or a public link.

  Effect safety is unchanged: an unknown or off history still never plays.
