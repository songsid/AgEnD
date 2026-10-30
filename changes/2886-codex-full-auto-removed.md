---
section: Fixed
---
- Codex instances with `skipPermissions: false` start again. Codex removed `--full-auto`, so these instances exited at launch with "unexpected argument". AgEnD now passes what that flag meant: `--sandbox workspace-write --ask-for-approval on-request`. Approval prompts are held for a person, as before.
