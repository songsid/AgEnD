---
section: Fixed
---
- **Discord · a slash command that showed "thinking…" no longer stays silent when its answer is lost.** If Discord does not accept the answer (a network blip, a dropped connection), AgEnD now logs it and tries once more — only the part that failed, so a long answer is never posted twice. If that fails too, it posts a short note in the channel saying the answer could not be shown and to check whether the command already took effect before running it again. The note never repeats the answer, since most slash replies are private.
