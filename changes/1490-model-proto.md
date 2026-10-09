---
section: Fixed
---
- **`/model`: reject names with newlines or control characters.** A model name containing `\n`, `\r`, or other control characters was persisted to `fleet.yaml` and pasted raw into the CLI session. The command now returns an error and does not write or paste. (#1490 P3a)
- **Instance lookups from user input now use `Object.hasOwn`.** Two plain-object lookups in the pause/wake and profile handlers accepted `__proto__` or `constructor` as valid instance names. Replaced with `Object.hasOwn` so inherited prototype keys are correctly treated as "not found". (#1490 P3b)
