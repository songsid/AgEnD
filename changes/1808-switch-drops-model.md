---
section: Fixed
---
- **An agent that switches an instance's backend no longer leaves it on the old backend's model (#1808).**
  - `update_instance_config` with a new `backend` and no `model` used to keep the instance's model. An agent moving an instance from claude-code to codex relaunched codex with `--model opus`, and every turn failed.
  - Now a backend switch drops the instance's own model and effort unless they are given, so the new backend runs on its default (or the fleet default it inherits).
  - A model the new backend does not take is refused before anything is written, and the refusal lists the backend's choices. The same goes for an effort level it does not have.
  - "Takes" is the rule `/backend` applies: the backend's offered list (and claude-code's known names); with no list known yet, its usual model-name pattern.
