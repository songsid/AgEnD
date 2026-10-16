---
section: Fixed
---
- **An agy instance on Linux gets its fleet instructions again (#1914).** AgEnD wrote them to `.agents/agents.md`, but agy reads `.agents/AGENTS.md`; on a case-sensitive filesystem it never saw them (on macOS's default case-insensitive disk both names are one file, so it worked there).
  - They are now written to `.agents/AGENTS.md`. An old `.agents/agents.md` on its own is renamed to the new name, keeping any lines you added to it.
  - If you already keep your own `.agents/AGENTS.md`, it is left as it is; only AgEnD's own blocks move out of the old file. The rename never replaces anything already at the new name, including a file created at the same moment.
  - If `.agents/AGENTS.md` is a symlink to a file that does not exist, AgEnD leaves it alone, does not write the instructions, and the launch tells you so.
