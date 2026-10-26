---
section: Fixed
---
- **No message is typed into an editor, pager or `!` command that owns a kiro pane (#2682).** While a kiro instance runs `/editor`, `/transcript`, a `!` command or a focused `/kvim` panel (legacy: `/editor`, `/reply`, `!`), AgEnD holds deliveries and shows "Kiro's terminal is in use by another program — finish or close it in the instance pane". Held messages go in once kiro's input row is back. Before this, the paste and Enter went into that program: a vi treated the paste as commands, and a `!` command swallowed it. #2676's busy insert would have typed into a running `!` command too. AgEnD now delivers only when kiro's own input row is on screen (the TUI composer, or legacy's prompt row), so a screen it does not recognise also waits.
