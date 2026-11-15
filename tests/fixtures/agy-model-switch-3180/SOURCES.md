# agy one-shot switching: M-3180

Actual standalone agy **1.4.7** and **1.5.9** binaries, retained from prior owned audits. 1.4.7 is the oldest version whose command+answer contract this change captures, not a claim that it introduced the command. Earlier/unknown versions keep restart fallback. Embedded changelog evidence on M-3174 says model arguments arrived in1.1.22 and effort in1.1.5; those old versions were not retained for this rig.

Both binaries ran in an owned bubblewrap user/mount/network namespace, scratch HOME/cwd and private tmux socket. Host HOME was not mounted. A local TLS mock answered only fake Google API requests through a namespace-only hosts file and scratch certificate. A fake token (`token` wrapper, mock account), synthetic five-model catalog and scratch onboarding completion allowed the UI to start without a real account. Telemetry was disabled in scratch settings; there was no external network or credential copy. No model/streamGenerateContent request was needed.

For each version: before; `/model claude-sonnet-5-5-high`; `/effort low`; `/model definitely-unknown`. The captured model/effort responses are new CLI exchange rows, not the footer. Scratch settings.json changed from the High display label to Low; the refusal left Low unchanged. The identifiers, email and paths in fixtures are the rig's own inert values. The five-model catalog deliberately includes both supported variants and missing-level cases.

The runtime verifier requires a fresh success/refusal after its pre-command capture. It does not use stale model headers, statusline text or quoted/fenced prose as confirmation. A missing model catalog cannot prove the display-label mapping and keeps restart fallback.

Binary SHA-256:1.4.7 `40349135371a8ed1f1af1e9f8b741de99174ae9fce6380b96c2d1f543480af7a`;1.5.9 `39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43`.
