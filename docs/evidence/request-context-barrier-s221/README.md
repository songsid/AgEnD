# Request-context compatibility bridge: slice A evidence

The new flow stays **off**. All production outbox constructors omit the trusted
capability option and remain version 0. No persistent barrier is installed by
normal startup. [Design and limits](../../design/request-context-compatibility.md).

## Fail-first and controls

At baseline `bb91baddbd36e78fea74d10b0e9197032b0108ec`, the retained base fixture
produces one semantic failure: a default legacy dispatcher opens a database whose
marker requires request-context v1. The legacy positive control passes. To repeat,
copy `base-repro.test.ts.fixture` into that baseline's `tests/` with a `.test.ts`
suffix and run Vitest. It uses only the old public API and owned temporary data.

Current focused files pass 22 tests. Eleven outbox/daemon/open-error/receipt/
contact neighbors pass 174 tests, including the final prepared-statement and
null-dispatcher controls. Source build/types and
test TypeScript pass. Removing the pre-initialization compatibility check makes
the startup controls red; replacing the UDF guard with a constant makes the
legacy-write control red. Both source files are restored byte-for-byte. A null
dispatcher result also fails first and is now treated as unsupported, never ready.

## Actual published-code execution

`published-packages.json` pins official public package versions, npm integrity and
archive hashes. The extracted package code is unmodified. All three run with Node
22.22.2 and compatible better-sqlite3 13.0.3, as recorded per case. No package
postinstall script or backend runs; local compatible dependencies supply SQLite.

For 2.3.3, beta.22 and beta.23, each original `DeliveryOutbox` implementation is
executed in a fresh Node child against disposable data. Active cases also call
the original `FleetManager.ensureDeliveryOutbox` startup recovery helper; this is
not a full launcher/service/deployment test. It establishes the production
recovery/publication boundary. Claim and begin/admit calls use the original old
methods. The only delivery port is a local counter after successful claim/begin;
there is no real daemon, terminal input or IPC send.

The twelve cases are:

| Fixture per old version | Expected outcome |
| --- | --- |
| OFF, queued | Legacy recovery/claim/begin succeeds; the stub delivery port is reached once |
| Active, queued | Recovery, claim and new admission refuse; unclaimed begin stays stale; startup outbox is unpublished |
| Active, claimed/in-flight | Recovery, begin and new admission refuse before writing; startup outbox is unpublished |
| Active, no delivery row | Even zero-match recovery refuses; new admission refuses; startup outbox is unpublished |

All nine active cases have zero successful claims/stub dispatch calls, with
unchanged delivery, attempt and human-receipt rows. The queued human receipt
proves preceding recovery writes roll back when the delivery UPDATE fails. Each
old startup helper fails with the missing-UDF cause and leaves no published
outbox. Three OFF positives show that merely adding unknown metadata would not
be a barrier. Results are `published-probes.json`; no host, token or real message
content is included. Raw logs/binaries remain private scratch evidence.

The parent runner alone creates its temporary root; it accepts no live data-dir
argument. Children receive an explicit environment allowlist. Process spawning,
TCP/HTTP/fetch APIs inside the old-code probe throw if reached; the final runs
have zero forbidden calls. Package metadata is read from the public registry,
never sent an AgEnD account or company data.

To reproduce with compatible installed/extracted published package roots and a
source build (`npm run build`):

```sh
node scripts/check-request-context-downgrade.mjs \
  /owned-scratch/stable-2.3.3/package \
  /owned-scratch/beta.22/package \
  /owned-scratch/beta.23/package
```

Use `npm pack --ignore-scripts` for the pinned public versions; do not run account
login or the product launcher. Do not point a probe at a live Fleet directory.

## What remains disabled

The v1 protocol validates shape only. It authenticates nobody and admits no work.
No new contact permission, root inheritance, Hub pass-through, UI or capability
advertisement is enabled. Only future complete dispatcher integration may select
capability 1. Its activation must follow the approved lifecycle and cutover gates.
There is no deactivation API before the later drain contract. An active barrier
intentionally blocks old binaries and the capability-0 bridge, even for empty
recovery. It is not protection against the host rewriting the database or code.
