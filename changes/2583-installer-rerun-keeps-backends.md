---
section: Fixed
---
- **Re-running the Windows installer keeps the AI backends that are already installed (#2583).** Before, it ran each chosen backend's installer again: Kiro's then asked "replace it?" with nobody to answer and the step failed, and a Codex installed by hand was installed again. Now a backend that is there and answers `--version` is kept, with its version shown, and its installer is skipped. The installer looks where the vendor installers put the CLI — `~/.local/bin` as well as the PATH, and npm's global folder (one found only there is linked into `~/.local/bin` so AgEnD finds it). Each CLI keeps updating itself.
