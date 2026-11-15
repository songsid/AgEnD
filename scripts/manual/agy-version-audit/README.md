# agy: every audit checks in-session model and effort switching

Run only a copied version in an owned isolated rig. The switch floor currently comes from retained positive captures of **1.4.7** and **1.5.9** (M-3180). It is not a claim that these commands first shipped in1.4.7. Earlier and unknown running versions keep restart fallback.

```sh
AGY_BIN=/owned/download/agy AGY_VERSION=1.5.9 bash scripts/manual/agy-version-audit/switch-rig.sh
```

This script creates a fresh scratch directory, copies the binary, and uses bubblewrap to hide the host HOME and isolate mounts, PID and network namespaces. Namespace-only loopback TLS plus fake OAuth/catalog responses are sufficient: do not copy credentials or make real model calls for this check. A short-lived scratch certificate and namespace-only hosts file are used; the host hosts file and networking are untouched. All tmux commands address the rig's private socket. Telemetry stays disabled in scratch settings. Inspect the retained `out/<version>/` frames and request paths; keep only redacted fixtures and binary hashes in the repository. Delete the owned scratch directory afterward.

Required cases on each newly audited version:

- Known one-token model ID: `/model NAME` produces a fresh `Model set to DISPLAY LABEL` response under its own `/model` exchange and the scratch settings select that label.
- `/effort LEVEL` produces a fresh `Effort set to LEVEL`; the model variant changes to that level where offered.
- Unknown model or unsupported effort: an explicit refusal, not a false success.
- With AgEnD's own statusline enabled, the same response rows still prove the change; never use its footer as model proof.
- Repeat a target and retain an old success: only a fresh response counts. Quoted/fenced response text must not count.
- An older/unknown running binary, busy pane or unverified result must send no unsupported command or take the restart fallback. A replaced running executable is unknown.
- Use the production daemon switch route in the rig once the shared switch seam is composed: idle-only gate, version gate, raw-paste serialization and reported verdict. Fleet persistence/restart/lifecycle fences are covered by focused tests.

A model spelling or response-layout change is a detector change and needs fixtures, parser negatives and a conservative fallback. Do not lower the version floor merely because `/model` appears in help. A slash argument may be interpreted differently by an older CLI.
