---
section: Added
---
- **Codex and Kiro accounts sign in from chat and the web dashboard.** A named Codex or Kiro account (credential profile) can now be signed in the same way as a Claude Code one: `/login codex <profile>` or `/login kiro-cli <profile>` in chat, or **Sign in** on its row in **Settings → Agents → Accounts**, including right after **+ Add account**. Codex signs in with a device code into the profile's own folder (`CODEX_HOME`), and Kiro opens its login picker with the profile's store (`XDG_DATA_HOME`). Before, these accounts could only be signed in with a command run on the host.
