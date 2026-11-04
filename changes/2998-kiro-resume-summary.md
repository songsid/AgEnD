---
section: Fixed
---
- **A classic kiro room no longer posts a resume summary into the channel (#2998).** kiro-cli-chat injects "In a few words, summarize our conversation so far." whenever AgEnD resumes a non-empty conversation. AgEnD never used that summary, so idle ClassicBot rooms spent tokens answering it after every restart. Classic (legacy UI) resume launches now pass a no-op INPUT that replaces the probe without a model turn. TUI, V3, and fresh launches are unchanged.
