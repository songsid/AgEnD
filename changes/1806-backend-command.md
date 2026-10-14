---
section: Added
---
- **`/backend`: move an instance to another CLI backend from chat (#1806).**
  - On Discord, Telegram and the web chat, with exactly `/model`'s permissions: a channel admin.
  - Pick the backend (only CLIs installed on this host), then its model (`/model`'s list, or the default), then its effort (`/effort`'s levels; skipped for a backend without one), then confirm. `/backend <backend> [model] [effort]` goes straight to the confirmation.
  - Nothing changes before the confirmation. Then backend, model and effort are saved in one write and the instance restarts **once**, in a **fresh session**: a conversation does not carry across backends. A turn in progress is interrupted. A stopped or paused instance is saved and not started.
  - It is `update_instance_config`'s backend switch: the new backend's own options apply, and a credential profile with no login for it is refused, with the command that logs it in. Nothing is left half-changed by a refusal.
  - An uninstalled backend, or a model or effort the new backend does not offer, is refused with the valid choices. The backend it already runs changes nothing; `/model` and `/effort` are named for that.
  - Fleet instances only: a ClassicBot agent's backend is set in `classicBot.yaml` or Settings, and `/backend` there says so.
