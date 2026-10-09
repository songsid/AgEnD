---
section: Fixed
---
- **`/model`: reject names with newlines or control characters.** A model name containing `\n`, `\r`, or other control characters was persisted to `fleet.yaml` and pasted raw into the CLI session. The command now returns an error and does not write or paste. (#1490 P3a)
- **Pause/wake handler: own-key check prevents inherited prototype keys from matching instances.** User-supplied instance names like `__proto__` or `constructor` are now checked with `Object.hasOwn` before the instance lookup, so they correctly return "instance not found" and never reach `runPauseWake`. (#1490 P3b)
- **Profile handler: own-key membership enforced before general_topic lookup.** `handleGeneralProfile` now checks `Object.hasOwn` before reading `instances[general]`, so an inherited prototype entry with `general_topic` cannot impersonate a real General — it is refused with "available only in General". (#1490 P3b)
