# Pointer-particle findings (#2057)

This follows the retained #2043 matrix, not a replacement for its failed receipts. The original report had six Firefox input/paint cases, four Firefox timing assertions and twelve individual Linux WebKit cases in eleven failed groups. A failed group can contain more than one case.

## Classification

| Original engine / width / theme / region / case | Classification and evidence |
| --- | --- |
| Firefox / 1366 / light / Chat / slow drag | Capture classifier: particles are visible in the original image, but the crop omitted the endpoint and the saturation threshold missed fading edges. |
| Firefox / 1366 / dark / Chat / slow drag | Same classifier defect; visible cyan, pink and orange particles in the retained image. |
| Firefox / 1366 / light / box / fast drag | Timing assertion: final send validation time was compared with the earlier acceptance clock. Corrected in #2043; its separate supplemental case passed. |
| Firefox / 1366 / dark / box / fast drag | Same timing assertion; supplemental case passed. |
| Firefox / 390 / dark / Chat / fast drag | Same timing assertion; supplemental case passed. |
| Firefox / 390 / dark / box / fast drag | Same timing assertion; supplemental case passed. |
| Firefox / 1366 / light / box / empty click | Invalid capture observation: the after-capture took 10,045ms; the sample's particles last about 1.2 seconds. This image cannot establish their absence at the requested observation time. |
| Firefox / 1366 / dark / Chat / empty click | Same capture limitation, 10,055ms. |
| Firefox / 390 / dark / page / degraded drag | Same capture limitation, 10,029ms. |
| Firefox / 1366 / light / Chat / bubble click | Product input loss: a preceding move can consume the send interval, after which an early rAF consumes and drops the queued click. A deterministic registry regression covers normal and degraded caps. This case also followed a stalled before-capture; that stall's cause has not been established. |
| WebKit / 1366 / dark / Chat / slow drag | Capture classifier: visible particles in the original image, missed by the endpoint crop / fading-color threshold. |
| WebKit / 1366 / dark / Chat / fast drag | Same classifier defect. |
| WebKit / 390 / light / Chat / slow drag | Same classifier defect. |
| WebKit / 1366 / light / Chat / slow drag | Product presentation defect, consistent with the independently reproduced iframe paint invalidation below. |
| WebKit / 1366 / light / page / empty click | Same presentation defect. |
| WebKit / 1366 / light / page / slow drag | Same presentation defect. |
| WebKit / 1366 / light / page / degraded drag | Same presentation defect. |
| WebKit / 1366 / light / box / slow drag | Same presentation defect. |
| WebKit / 1366 / dark / Chat / empty click | Same presentation defect. |
| WebKit / 1366 / dark / Chat / bubble click | Same presentation defect; coalescing input loss is also independently addressed. |
| WebKit / 1366 / dark / page / degraded drag | Same presentation defect. |
| WebKit / 390 / dark / Chat / slow drag | Same presentation defect. |

The nine WebKit rows are symptoms consistent with a shared, experimentally isolated product cause, not nine independent causal experiments. The Firefox capture classification invalidates those late observations; it does not identify the browser/automation stall's cause or claim every Firefox capture is reliable.

## Product causes and boundaries

### Presentation

The registry checks geometry each rAF. The old geometry helper hid the iframe, rewrote the same fixed rectangle and clip, forced layout and revealed it on every call. A diagnostic Worker drew persistent red directly in its pointer callback, cyan through `agend.frame` and green through a timer. All three were present in the canvas bitmap while missing from the page. A private headed Xvfb framebuffer, read without Playwright screenshots, independently showed the delay. Thus the evidence is not solely an automation screenshot artifact or a missing Worker frame callback.

In two headed Linux WebKit controls, the nominal 300ms framebuffer captures (actually 362/384ms) had none of the marks. With the production geometry fix, captures at 376/397ms had all three. An independent host rAF sentinel measured about 15–16fps in the preceding one-second baseline window and about 61fps with the fix. This is a controlled private Linux environment, not a hardware benchmark. Post-screenshot cadence can still fall; no claim is made that every interval stays above 55fps.

The fix skips writes only for a previously revealed frame whose **fresh** stock proof, ancestor axes, desired clip, computed properties and physical rectangle all still agree. New holes and uncertain geometry hide before changes. A lost hiding cascade physically removes the frame. Initial bind, caps, safety budgets, consent and focus rules are unchanged; a cached permission cannot authorize paint.

### Coalescing

Previously the registry cleared its one pending pointer sample before checking whether the 60/30Hz interval had elapsed. An early rAF therefore lost a click after a move. It now retains that latest sample until a permitted frame, preserving the original timestamp and 100ms expiry. Movement replaces earlier movement, but cannot replace a fresh pending discrete event. A later discrete event replaces an earlier one, so a near-simultaneous down/up/click sequence deliberately coalesces to its final click. An expired discrete sample cannot block new motion. There is still only one slot, no event queue or guarantee to deliver every intermediate input. Every send still checks current ownership, stock/focus permissions, ready state and profiler forwarding. Revocation or invalidation discards pending input.

## Capture checks

The particle recipe compares before/after pixels across the whole gesture, including its endpoint. It recognises the three sample colors blended over the actual before pixel, rather than requiring a highly saturated final pixel. Unchanged colored UI, ordinary blue text selection, missing paint and expired capture observations have negative controls. Required clicks and normal/degraded drags still need both accepted native input and more than 15 independently changed particle pixels. Packet receipt alone is never visual success. A capture exceeding one second is invalid evidence and makes the recipe fail; failures are retained, not silently retried into success.

Run after build/postbuild with an isolated Playwright installation:

```sh
PW_DIR=<private-prefix> OUT_DIR=<private-output> \
  PROBE_ENGINES=chromium,firefox,webkit \
  node scripts/manual/effect-pointer-particles-1629.mts
```

`PROBE_WIDTHS`, `PROBE_MODES`, `PROBE_SURFACES` and `PROBE_GROUPS` select separate supplements without replacing originals. `PROBE_GROUPS=coalesced-click` primes a real degraded move before a trusted click and subsequent motion. Driver latency can cross a send interval; deterministic unit clocks pin the exact 1ms interleaving. `PROBE_MUTATION=no-paint`, `old-focus`, `drop-pending` or `overwrite-discrete` are served-source/sample reversals, never product configuration. `scripts/manual/effect-geometry-1629.mts` checks fresh geometry, protected pixels, hole movement and cascade refusal.

The loopback harness uses actual stock Shell/Chat, service/library, preview listener, Worker and runtime, with a private synthetic session. It does not prove real login, public gateway behavior, physical touch scrolling or real Safari. Optional native touch/cancellation observations remain separate from required mouse cases. All browser processes, profiles and listeners are private and cleaned up.

The degraded-input fixture normally blocks its private page for 75ms every 180ms. If a host's measured baseline is already low, that may not induce a degraded window: a timeout with a still-normal row is a failed load-induction control, not a passed 30Hz test. A separately named supplement can set bounded `PROBE_STRESS_MS` / `PROBE_STRESS_PERIOD` (for example 150/200); the receipt records them. Keep the original failure and distinguish the supplement rather than silently retrying.

## Risk and rollback

The stable presentation path can expose a missing fresh check if future code accidentally caches permission or omits actual geometry; regressions pin those checks and changed-hole ordering. The input fix deliberately keeps only one fresh sample and retains all existing caps. Reverting the production changes requires no data migration and restores the previous paint/input defects. Reverting only capture tooling affects evidence, not authorization or playback.
