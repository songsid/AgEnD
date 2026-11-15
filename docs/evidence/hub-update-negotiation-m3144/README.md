# M-3144 update negotiation

The member can offer 32 capability names. A connection closed before welcome gets one retry on the same authenticated pairing and endpoint, dropping only `fleet-update-v1`. The legacy choice remains for that client lifetime; a new connection client after a Hub upgrade negotiates again. Authentication refusals and failures after welcome do not trigger it. A modern Hub includes this offer, and can exceed 16 welcome names, only when the peer offered it.

This slice adds negotiation support; it does not offer remote updates from the production factories or launch an updater.

Validation:

- `vitest run tests/hub-update-capability-bounds-m3144.test.ts tests/hub-protocol.test.ts --maxWorkers=2`: 31/31. Both new boundary cases failed against the previous implementation (see the red log).
- One owned TLS/WSS packet, inert directory and temporary paired profiles: 4/4 cases, including a beta.3-shaped 16-name hello codec, exact-offer fallback, both welcome sizes, and bounded refusal. Two added negative cases were then run separately: 2/2, authentication refusal and post-welcome reconciliation failure. No duplicate network campaign.
- Existing reaction capability pin, selected alone: 1/1; the legacy list remains exactly 16.
- Native TypeScript source and test programs: exit 0 (empty success logs).

No real Fleet, AD, vendor API, updater, install, or restart was exercised. The beta.3 fallback must also be included in the later phase-3 real-update rehearsal.

Rollback: disable the new phase-3 offer. Do not truncate older capabilities or reset pairing data.
