---
section: Fixed
---
- **Pressing Sign in could freeze the whole AgEnD (#3212).** The web terminal's output reached AgEnD through a FIFO that tmux's `pipe-pane` fed with `cat`. On Linux 6.6, GNU `cat` copying into a FIFO holds the pipe's lock while it waits for more output, so AgEnD's own read of that FIFO blocked in the kernel and the whole process stopped as soon as a login printed its first lines and waited for input ("can't reach AgEnD"). The pipe now uses `dd`, which never holds the lock and passes output through as it arrives.
