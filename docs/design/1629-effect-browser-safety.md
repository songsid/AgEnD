# Browser effect safety receipts (#1629 B2)

`src/ui/shared/effect-safety.js` is an **unmounted** synchronous participant for the registry's safety seam. It imports only the reviewed pure pause-history policy. There is no product import, static allowlist, startup work, frame, route or concrete Settings control in this PR. Profile measurements are a separate concern and are not stored here.

## Why separate receipts

The registry must receive a positive storage acknowledgment before creating a frame. A best-effort in-memory flag cannot suspend an interrupted trial on the next page load. A single localStorage index rewritten independently by several tabs would lose one tab's pause or marker. The participant instead stores individually keyed, closed receipts under `agend_effect_safety_v1:`:

- **Probation:** random page owner and token, content id, device class and wall instant. `begin` writes and reads back before returning a token, then rechecks for another page's unresolved trial. `finish` removes only the exact record this participant owns; replacement, failed removal and repeated use are refused.
- **Pause:** an immutable random receipt containing only id, class and wall instant. Its presence is the soft-pause latch until explicitly acknowledged by a human Resume.
- **Resume:** acknowledges one exact observed pause token. It does not remove history. A pause added concurrently is not in that action's snapshot and remains paused. No principal/instance name, host key, content, URL, metric or effect-provided value is stored.

No shared read/modify/write history array is published. Cross-tab pauses have different keys; simultaneous human acknowledgments of one pause have the same idempotent record. The API validates the entire bounded namespace before using it. This avoids lost writes; it does not claim an atomic multi-key snapshot or disk-fsync semantics from localStorage. Native storage acknowledgment is the browser persistence contract. Enumeration that changes, a missing item or ambiguous cleanup fails closed.

## Policy and recovery

Each id/class replays its immutable pause receipts in timestamp order through `newEffectPauseHistory` / `recordEffectPause`. Three pauses in any rolling 24-hour interval turn that version off permanently for the class. Replaying the retained history preserves that off result even if nobody opens the dashboard until after the timestamps age out. Human Resume does not erase it. A new content id or another class has separate state. New writes clamp wall time against all matching recorded instants; wall rollback cannot make pauses disappear.

A probation marker from another participant means **an interrupted or still-pending trial**, not proof that the effect froze a tab. A new page conservatively refuses it. Another live tab's first five seconds can therefore temporarily block that effect in this tab. It becomes eligible when the original owner clears its marker, or a human explicitly resumes. Human Resume can remove a foreign pending marker; the original owner's next namespace read (or exact finish) then fails closed and its registry must stop. Still-owned records are compared byte-for-byte on each read; repairing them does not clear that page's fault. This conservative cross-tab behavior is preferable to silently treating an unresolved trial as healthy.

This page's own pending tokens remain intact during Resume so the registry can retire them through `finish` before recalibration. Unknown storage, quota failures, silently ineffective writes, corrupt schemas, dangling acknowledgments, nonce collisions and failed removal latch this participant closed. It never repairs or resets unknown data and never falls back to memory. Safe mode and disabling effects remain independent product escape hatches; no effect is required to run to operate those controls.

## Bounds

Reads are limited to 4,096 total origin keys, 2,048 owned receipts, 1,024 UTF-16 units per record and 512 KiB for owned key/value UTF-16 storage. Some limits overlap. Closed records contain only ASCII identifiers, enums and safe integer timestamps. Old historical pause receipts are deliberately retained to preserve sticky-off evidence; reaching the bound refuses effects rather than dropping that evidence. Unrelated origin keys are neither parsed nor changed. The participant is lazy and synchronous, with no timer, listener, background scan or persistent in-memory healthy fallback.

## Verification and limitations

Unit controls cover persistence before acknowledgment, ownership and one-use cleanup, interrupted reload, human Resume, permanent off, wall rollback/boundary, immutable snapshots, interleaved two-tab writes and a new pause racing Resume. Storage/crypto/quota/schema failures refuse instead of clearing authority. Metrics getters are never read.

`scripts/manual/effect-safety-1629.mts` uses actual localStorage and crypto in Chromium, Firefox and Linux WebKit on an isolated loopback origin and private browser contexts. It checks cross-page/reload interruption, separate pause receipts, explicit recovery and sticky off after reload/aging. It creates no frame or fleet. Linux WebKit is not real Safari. A browser acknowledging localStorage does not establish physical durability through power loss; a bounded history namespace can eventually require human browser-storage maintenance. None of these receipts is a server authorization or a claim about Worker CPU, GPU, memory or culpability.

## Risk and rollback

Conservative storage or cross-tab ambiguity can suspend a valid effect. Product wiring must honor the positive synchronous receipts, expose human Resume and never let agents clear browser safety state. This PR adds no migration/config/startup behavior. Rollback is reverting this unmounted module/tests/recipe/docs; future readers must not reinterpret unknown v1 receipts as health.
