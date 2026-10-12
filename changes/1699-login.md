---
section: Added
---
- **Sign a Claude Code profile in from chat: `/login claude-code <profile>` (#1699).**
  - It runs `claude auth login` for that profile in the same browser terminal `/login claude-code` uses, so it works
    from a phone. On Discord, `/login` has a new `profile` option.
  - Only the agents on that profile are woken or restarted afterwards. Signing in the default login no longer restarts
    agents on other profiles.
  - When an agent's profile sign-in expires, the alert offers a button for that profile.
  - Kiro and Codex profiles are still signed in on the host; `/login kiro-cli <profile>` replies with the command.
