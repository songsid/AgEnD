---
section: Added
---
- **Scroll back in the View terminal (#2969).** Scroll up with the mouse wheel, a touch drag, PageUp, or **Earlier output** to read what has scrolled off an agent's terminal (up to 2,000 lines, read once when you ask). While you read, live output never pulls you back down. **New output below · Jump to latest** appears instead, and you follow again at the bottom. Scrolling happens entirely in your browser over a read-only copy of the terminal, so it never affects message delivery. Codex, Kiro and Muse keep this history. CLIs that redraw their whole screen (Claude Code, OpenCode, Grok) have none, and the View says so. For Claude Code, the View links to its Log tab, which shows that earlier output, or says where to turn the Log tab on.
