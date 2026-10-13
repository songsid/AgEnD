---
section: Fixed
---
- **A grok instance quits cleanly on stop, pause and restart (#1792).**
  - Grok quits only on a second Ctrl+Q within one second. AgEnD sent one, so grok only showed "press again to quit". Every stop then waited three seconds and force-stopped it.
  - AgEnD now sends Ctrl+Q twice, 250 ms apart. The grok 1.0.52 audit found this; 1.0.52 itself is otherwise unchanged for AgEnD.
