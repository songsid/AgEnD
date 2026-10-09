---
section: Fixed
---
- **`retireSystemCopy`: uses the same npm that performed the install, not a re-queried PATH npm.** The npm binary path is resolved once during `runUpdateInstall` (from `nvmBin` for nvm installs, or via `command -v npm` for system installs), stored in the outcome, and passed to `retireSystemCopy`. This ensures consistency between install and cleanup — for nvm installs, the nvm npm is used rather than whatever parent PATH contains. The function now returns `{ ok: boolean }` so callers can observe retirement failures. Missing or non-absolute npm path is an explicit failure, not a silent skip. (#1490 P3)
