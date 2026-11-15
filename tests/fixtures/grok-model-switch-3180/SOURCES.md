# Grok inline switching: M-3180

Actual standalone **Grok1.0.70**, copied from the installed release into an owned bubblewrap rig. Host HOME was hidden, with private mount/PID/network namespaces and tmux socket. Only a loopback mock and fake API key were available; no real account or model request. The mock's three-model catalog advertised reasoning support and low/medium/high/xhigh. No host pane or Fleet was touched.

Commands: `/model grok-4 high` → fresh `Switched to grok-4 (high effort)`; `/effort low` → fresh `Switched to grok-4 (low effort)`; unknown model → `Unknown model: definitely-unknown`. Scratch config persisted `models.default = "grok-4"` and `default_reasoning_effort = "low"`. Transient refusal rendering replaced the success rows, so verification compares multiplicities of the exact result rather than total notice count.

The binary's embedded user guide says `/model NAME [WINDOW] [EFFORT]` and `/effort LEVEL`. A model-only command on the reasoning catalog can open a picker; unconfirmed input takes restart fallback. Initial mock attempts omitted reasoning traits and were refused (not accepted as proof); final captures include explicit traits. 1.0.70 is the oldest retained complete switch contract tested here. Earlier versions keep restart, regardless of help-command presence.

Copied binary SHA-256: `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9`.
