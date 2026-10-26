---
section: Changed
---
- **CI: the artifact actions move to their current majors (#2671).** `actions/upload-artifact` 4.6.2 → 7.0.2, `actions/download-artifact` 4.3.0 → 8.0.2 (a download whose digest does not match now fails the job) and `actions/upload-pages-artifact` 3.0.1 → 5.0.0, still SHA-pinned. They run on Node 24. No workflow step changed: every download is by name, no uploaded directory relies on hidden files, and the website build has no dotfiles. Nothing changes for users.
