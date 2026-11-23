# Deterministic long-line secret-scan regression (M-3531)

The old assertion required two scans to finish within 2,000 ms. Run 45114998262 attempt 1 reported 2,045 ms and passed on rerun. Elapsed time includes scheduling and instrumentation costs, so it is not a deterministic complexity check. The intended protection is bounded scan work on arbitrarily long lines: secret detection must continue deep into the line without passing the whole line to potentially expensive regular expressions.

Production already splits each line into overlapping pieces of at most 4,000 characters with a 3,000-character advance and checks nine expressions per piece. Production is unchanged. The test now observes the actual `RegExp.prototype.test` calls during a synchronous scan, delegates every admitted call to the original implementation, and enforces:

- each regex input has at most 4,000 characters;
- at most `9 * max(1, ceil(n / 3000))` regex calls for a single line of length `n`;
- aggregate regex input at most 4,000 times that call budget;
- nonzero calls and input, plus the original expected secret findings.

The clean-input cases cover 6,000, 12,000, 24,000 and 200,000 characters. The original secret beyond 80,000 characters is still found. Each spy is restored in `finally`. The guard throws before excess work is executed, making a bad scan cheap to reject. There is no elapsed-time assertion, higher timeout or retry.

This bounds work *presented to* the regex engine; it does not count its internal backtracking steps or prove every future expression safe. Keeping each input bounded is the existing defense against long-line growth. Individual regex changes still need their own review.

## Validation

At base `942575ddc271d7f7fbce7a982c5fa922d646597d`, the updated file passes all 43 tests. Two isolated source mutations make the new target test fail with `secret scan exceeded deterministic work budget` (one failed, 42 skipped each), rather than a collection error or timeout:

1. `quadratic.patch` repeats every window's regex work `line.length` times. Without the test guard this multiplies an O(n) scan into O(n²), even while each piece stays bounded. The call budget rejects it.
2. `unbounded-piece.patch` gives each regex the entire remaining suffix. The per-call input cap rejects it.

Both exact patches and their source hashes are retained. The source is restored byte-for-byte, and the target test passes again. Reproduce each independently with `git apply <patch>` and `vitest run tests/agent-export-163.test.ts -t 'bounding regex input'`, then restore the production file. A final TypeScript-only `this: RegExp` annotation was added to the spy after the initial test-types check reported TS2683. The corrected target passes; this annotation erases at runtime, so the 43-case run and two mutation results carry without repetition. Build and final test types pass. Local runs use nice/ionice. Full suites remain CI's responsibility.

Current main `bb54f7e6e6e559f863c0d996121f64e95b3175fa` has neither `src/agent-export.ts` nor `tests/agent-export-163.test.ts`, so this is Dev-only with no main twin. No UI, filesystem scanner, credentials, accounts or live CLI are exercised beyond the existing focused test fixture. Risk is confined to test instrumentation; reverting the test restores the timing flake without changing production behavior.
