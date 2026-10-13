---
section: Fixed
---
- **AgEnD no longer reads a huge transcript all at once (#1218).**
  - Before, when an agent wrote a lot between two reads (a long command's output, a multi-MB tool result, a 300 MB codex session catching up), AgEnD read the whole difference into memory in one go on its main loop.
  - It now reads at most 1 MiB at a time, a few times per poll, for claude-code, codex, kiro and muse session files.
  - A line longer than 256 KiB that holds a turn's record or a reply is still read whole, up to 16 MiB: a codex turn end with a long final reply, a pasted prompt, a long claude reply, any kiro record. So the end of a turn is never missed.
  - Any other long line, such as a multi-MB tool output, is known by its first 8 KiB, which still say which tool step it belongs to, so the progress line does not lose that step.
