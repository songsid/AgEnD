---
section: Fixed
---

- Claude instances on Linux/WSL detect deleted or npm-temporary executables and attempt one restart with the same conversation. Claude's own model-version refusal also checks the installed package before deciding whether to restart or ask for an update. Repeated failures stop automatic retries and give a plain notice.
