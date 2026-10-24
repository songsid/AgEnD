---
section: Fixed
---
- **The Windows installer no longer hangs on "OpenAI Codex" (#2583).** Codex's install.sh ends by asking "Start Codex now? [y/N]" on the terminal, and under the installer nobody could answer, so the step spun until it timed out. Every backend's install now runs with no terminal to ask on (kiro's "replace it?" on a reinstall was the same trap), and Codex's with `CODEX_NON_INTERACTIVE=1`. `/login` installing Codex for you sets it too. The command shown for you to copy is unchanged.
