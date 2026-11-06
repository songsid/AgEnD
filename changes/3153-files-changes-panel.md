---
section: Added
---

- Web chat: **Files & changes** (an agent's ⋯ menu) shows the folder the agent works in, read-only, in the side panel (a full-screen sheet on a phone). **Changes** lists what is uncommitted against the last commit (git status, the diff, new untracked files); **Files** browses the folder (gitignored entries left out) and shows a text file with line numbers or an image. It refreshes on demand and when the agent replies. Only this computer's signed-in admin sees it (never a guest or the public link), only inside the agent's own folder (links are listed, never followed), never for General or a coordinator. Secret-looking files (`.env`, keys, certificates, credentials) are listed as hidden and never shown; big files and diffs are cut with a note. (#3153)
