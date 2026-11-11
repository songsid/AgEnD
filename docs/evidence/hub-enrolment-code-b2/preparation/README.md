# B2 preparation evidence — not final acceptance

Dependency: draft B1 #3673 at fb3d858755af7f55a5d8226679c8a00f33604749.
U2 has not been composed into this branch. No parity review is requested yet.

The new module, shared client calls and both Hub approval paths are implemented.
Root cause for the queue change: a one-shot approve surfaced temporary directory
or admission backpressure instead of waiting on the same request. The new queue
keeps that request and its original deadline; permission and limit failures do
not enter the queue.

Verification in the owned checkout:

- 143/143 tests in ten suites: code client/session/component, pure queue,
  mounted queue paths, quick-pairing UI, company-join UI, both Hub UI suites and
  unchanged CSP scan. The last markup-only scope/wrapping additions were then
  checked with the component's 26/26 tests.
- Native TypeScript source and test checks pass. Changelog assembly validates
  380 fragments; `git diff --check` passes.
- 17 syntax-valid, isolated source reversals each fail their intended semantic
  assertion. The script restores each source file byte-for-byte, including when
  an assertion or command fails. Results are recorded alongside this file.
- Fail-first logs cover absent client methods/capability and the actual server
  session feature; the v3 opt-in and code-approval copy each failed semantically
  before their changes. The queue's new-feature contract used a transparent
  one-shot adapter, not a claim of a mounted original UI regression.
- An initial semantic-refusal mutation test waited on the deliberately queued
  promise and timed out; it is excluded as proof. The test now observes settled
  state after a timer flush, and the final reversal fails by assertion.

Boundaries: mounted Preact uses inert client/fetch with synthetic values. The
session feature test uses an owned actual HTTPS Hub and synthetic LDAPS.
There is no real company account, backend CLI, native Windows, live directory,
pilot, or deployed Fleet operation. No current PNG, container-capacity or
complete U2 journey claim is made here.

Still required before review: plain-sync landed U2/B1; compose the actual group
picker and slot; retain U1's connected-tab closing/refusal behavior; finish the
member notice-v3 opt-in with the Fleet UI owner; run real-shell EN/zh-TW desktop
and phone images, current/old-shell and old-CSS SKEW, and B-L* including five
distinct Fleet interfaces and 50 connections inside five minutes. Earlier B1
technical-client evidence is not substituted for these legs.

Risk: asynchronous UI and deployment skew; current tests pin retirement,
deadline honesty, exact requests, explicit notice version and safe fallback.
Rollback: revert B2's UI/session-capability additions. B1's records, codes,
credentials and schema remain unchanged; old consumers retain unread v3 rows.
