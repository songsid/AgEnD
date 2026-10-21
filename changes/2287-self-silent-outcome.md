---
section: Fixed
---
- **Self-scheduled silent work no longer receives its own delivery-outcome prompt (#2287).** Unconfirmed or failed self-silent pastes keep their diagnostic state and log without generating a new message or operator alert. Schedules from another instance retain their existing notifications. Codex rollout ownership remains separately tracked in #2301.
