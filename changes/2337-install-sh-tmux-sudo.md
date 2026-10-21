---
section: Fixed
---
- **The install one-liner can install tmux as root without a sudo binary (#2337).** Step 3 hardcoded `sudo` for apt/dnf/pacman, so a root shell in a minimal image (Docker, some WSL/LXC setups) failed with `sudo: command not found`. It now uses the same `$SUDO` as the build-tools step (empty as root). A non-root user without sudo gets a clear error to install tmux and re-run.
