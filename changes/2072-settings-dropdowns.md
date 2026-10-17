---
section: Changed
---
- **Every backend and model field in web Settings is a list (#2072).**
  - **Backend fields:** each backend field (an agent, the fleet defaults, ClassicBot, the older fleet config form) lists every backend with what this host says about it. One it cannot run is shown, disabled, with why; the current one can always be chosen.
  - **Model fields:** each model field (an agent's model and failover, the fleet default, a ClassicBot room, a new agent) lists that backend's models for that agent's account, from the cached list. The current model is always listed, marked when the CLI does not list it, and "Other…" takes a name the CLI does not list.
