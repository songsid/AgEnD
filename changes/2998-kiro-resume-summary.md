---
section: Fixed
---
- **A kiro room no longer posts a resume summary into the channel (#2998).** kiro-cli-chat injects "In a few words, summarize our conversation so far." whenever AgEnD resumes a non-empty conversation. AgEnD never used that summary, so idle ClassicBot rooms spent tokens answering it after every restart. Resume launches now pass a no-op INPUT that replaces the probe without a model turn. Fresh launches are unchanged.
