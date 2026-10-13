---
section: Fixed
---
- **AgEnD no longer reads a huge transcript all at once (#1218).**
  - Before, when an agent wrote a lot between two reads (a long command's output, a multi-MB tool result, a 300 MB codex session catching up), AgEnD read the whole difference into memory in one go on its main loop.
  - It now reads at most 1 MiB at a time, a few times per poll. A single line longer than 256 KiB is skipped after its first 8 KiB, which still tell AgEnD which tool the step belongs to, so the progress line does not lose it. This applies to claude-code, codex and kiro session files.
