---
section: Fixed
---
- **Files an agent attaches to a reply stay available in web chat after a fleet restart (#1770).**
  - Before, a reply's .html or .png usually showed as "unavailable" after an update or restart, because web chat only kept files that sit in the instance's inbox, and agents usually send files from /tmp or their working folder. A file also broke if the agent later rewrote or deleted it, or /tmp was cleaned.
  - Web chat now keeps its own copy of each reply file in `workspaces/<instance>/web-files/` and shows that copy. A symlink, a file over 50 MB, or a file inside the AgEnD state folder (other than inbox/) is not shown.
  - Copies are deleted when their message leaves the web chat history. Each instance keeps at most 1 GiB; above that, the oldest copies go first. When a copy is gone, its message shows the file as unavailable, as before. Telegram and Discord are unchanged.
