---
section: Fixed
---
- A read or write error on any helper process's stdin, stdout or stderr pipe (tmux, git, the update launcher, usage and memory probes, and the others) now fails that one command instead of crashing the whole fleet. Fleet code now gets `spawn` and `execFile` from one guarded module, and a test fails if new code imports them straight from Node (#2374).
