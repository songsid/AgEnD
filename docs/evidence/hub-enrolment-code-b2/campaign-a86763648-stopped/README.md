# Fresh-slot campaign stopped before diagnosis

Current B2 source: `a86763648f042560761fcd7dfca974f03ad3701d`. PR #3706 remains draft. B1 is merged as alpha `8c4b4a34b91b5b47251b78684c23587bb003eb00`; B2 was plain-merged first. No B1 product change or timeout relaxation is included.

The slot authorized diagnosis first, then the missing acceptance legs, ending by07:50Z or run completion. Attempt871cd35a at `ddcf18132388f3ef5985b16762993e81e970bf75` failed its protocol preparation:118/119 passed, while the first EN real lazy-slot fixture clicked an absent button. The test-only fix waits for the observable button/form boundary; its configured local run passes85/85 across17files with original write/read/revoke assertions and timeouts unchanged.

Attemptab8ee68d at the current source built successfully, but the host sampler reached load12.67 at06:00:31Z and raised STOP during protocol. The child settled with143. The host load was still15.67 at06:01:08Z after cleanup. Available memory never fell below15823.93MiB during this attempt; container peak1780273152bytes, with no OOM. The container limits remained2CPU/3GiB with no extra swap allowance.

Both attempts stopped before the combined wave, so neither produced the CPU/SQL/fs diagnostic. #3713 remains undiagnosed: backend contention and harness contention are both unproven. SKEW, actual member upgrade, revoke, style and rollback remain unrun in this slot. No acceptance pass, performance-cause claim, backend fix or review request follows from these records. The prior50+3failure remains in `campaign-4545c30f6-failed`.

Owned container, labelled image, watcher and ACTIVE lock are absent for both attempts. Full raw receipts/logs and hash manifest are retained here. A further heavy attempt requires a new coordinator window; no automatic retry runs.
