# R2 clock-warning refinements

This delta is limited to Lumen round2 A/B/C. No signature, delivery/principal mapping, two-phase input barrier, companion retention, negotiation or authority behavior changes.

- **A — warning lifetime:** the in-memory warning carries the authenticated ask's signed retainedUntil. `attentionItems()` removes expired entries, rather than hiding them reversibly; moving the clock back does not resurrect the removed warning. Needs you already refreshes every10s, so expiry needs no additional timer, probe or later accepted proof. Both skew directions failed before the fix (2 assertion failures), then passed. The expiry test injects the same daemon clock into the store and attention adapter.
- **B — retry:** room-clock items omit retry/hubRetry. Existing mounted EN/zh-TW Needs-you views now explicitly verify the localized warning is visible, the Try again/再試一次 button is absent, and no retry POST occurs. The ordinary hold retry route is unchanged; no room-clock id is offered to its representative-only handler.
- **C — copy:** both identical strings moved into `src/locale.ts` as `hub.room.clockSkew`, rendered with request-local `tForLocale`. Typed locale parity and the mounted bilingual controls cover the wording; no inline English/Chinese sentence remains in the adapter.

Scoped verification:34 tests/2files passed (adapter22 and existing retry/UI suite12), including the four additional A/B controls. The before-fix patch applies to30becd25 with `git apply --unidiff-zero`; its two captured input digests bind the actual expiry regression. Prior proof stays historical/carried; no repeated broad/native/browser/provider campaign. The mounted view uses the existing in-process application harness, not a browser capture or live service.

Final test types and build/postbuild exited0. R1 implementation/proof remains separately scoped; this revision adds no input/identity authority and no retry handler.
