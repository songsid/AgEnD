# Outside-connections TOTP fixture clock

The test creates the previous step's enrollment code, then sends it over real local HTTP. `WebRemoteAccess.confirmEnrollment` evaluates `matchTotp` at receipt: it accepts the current step and one step either side. If the host clock advances from step S to S+1 after generating S−1, that code is now two steps old and correctly returns `wrong`. Enrollment uses the previous step so the subsequent current-step sign-in exercises replay protection without waiting.

A regression advances the host wall clock by one 30-second step immediately before the real enrollment validation. Against the original fixture it reproduces the same 400/wrong assertion. The corrected fixture injects the existing authenticator clock port and uses that same fixed clock for all its codes. The HTTP server, gateway, secrets, monotonic enrollment expiry, timers and assertions remain real. No runtime source, acceptance window, replay rule, timeout or retry changes.

Validation:

- Forced rollover on the original fixture: one assertion failure, matching the enrollment failure.
- Corrected complete `outside-connections-3008.test.ts`: 29 passed, including the forced rollover and retained authority/replay controls.
- Original Off/re-enroll/remove lifecycle: 200/200 passed serially, without retries, stopping on the first failure. Each case creates a fresh FleetManager, temporary directory and random authenticator, then cleans them up.
- Changelog assembly and test typecheck passed.

Run the serial check from the repository root with `node scripts/manual/outside-totp-m3893/repeat.mjs`. It refuses an existing temporary test file, generates only the 200-case test expansion, removes that file in finally, and verifies the report count, success, zero failures and unchanged HEAD/source digest. Private reports are not committed; `verification.json` binds their digest and the executed source.

Limits: the 200 cases share one Vitest worker/process and a warmed import graph; this is not 200 cold starts or a CPU contention campaign. The original CI failure was not instrumented at code generation and validation, so the boundary mechanism is reproduced, not retrospectively timed. No vendor calls, native authenticator, browser or live Fleet operation. Rollback removes the test fixture clock and regression; runtime is unaffected.
