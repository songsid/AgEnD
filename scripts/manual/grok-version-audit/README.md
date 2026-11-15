# Grok: every audit checks inline model and effort switching

The complete captured contract currently starts at **1.0.70** (M-3180), not a claim of first introduction. Older and unknown running versions keep restart fallback. Use the actual new binary and the oldest retained contract binary, copied into an owned scratch directory.

```sh
GROK_BIN=/owned/download/grok GROK_VERSION=1.0.70 bash scripts/manual/grok-version-audit/switch-rig.sh
```

The script hides host HOME and isolates user, mount, PID and network namespaces. A loopback mock supplies a synthetic reasoning-capable model catalog and fake API key; it calls no account or external model. It uses only its private tmux socket. No installed CLI, default tmux server, real Fleet or real credential changes. Inspect `out/` captures and request-path log, redact before committing fixtures, and remove the owned scratch directory afterward.

For each new CLI audit:

- `/model NAME EFFORT` on a model whose catalog advertises that effort gives a fresh `Switched to NAME (EFFORT effort)` notice.
- `/effort LEVEL` changes the current model's effort and gives the same notice form, preserving the model.
- `/model UNKNOWN` gives an explicit refusal. Unsupported effort/model capability also refuses.
- On models requiring a window/effort choice, an incomplete `/model NAME` may open a picker. No confirmation means restart fallback; do not navigate the picker or type a guessed default.
- Only a new exact-result occurrence confirms. Transient notices can replace old notices, so total history-line counts alone are insufficient. Stale/quoted/fenced prose must not prove a switch.
- Check AgEnD's real daemon route in the private rig: running-version proof, idle-only admission, serialized input, fresh verification, matching requested model and effort. Busy/old/unknown/mismatch outcomes must retain the restart fallback and the saved config.
- A changed notice shape, argument parser or picker behavior needs fixtures and fail-first parser controls, not a broader success regex.

The floor requires a proven running executable, not merely the installed symlink or a cached version for another process. A replaced/deleted executable is unknown. The version probe uses disk metadata first and the existing bounded netless path otherwise.
