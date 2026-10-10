---
section: Fixed
---
- **`retireSystemCopy`: uses `join(nvmBin, "npm")` for all npm operations.** For nvm installs, `npm` binary path is now `join(plan.nvmBin, "npm")` — the same binary npm actually invokes via the modified PATH in `inInstallEnv`. This path is used for prefix lock, rollback root, install, verification, and retirement, ensuring `outcome.npmPath` matches what was actually invoked. `retireSystemCopy` takes the explicit path and returns `{ ok: boolean }`; callers set `process.exitCode = 1` on failure. Non-nvm installs do not perform retirement and skip the lookup. (#1490 P3)
