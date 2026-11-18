# M-3315 owned scratch evidence

Date: 2026-11-18. Source pin: `ad2a86ccff5c42cf43d8664d697e413342632aa1`.

The [manual probe](probe.ts) borrows production dispatcher/admission methods without constructing or starting a FleetManager. It creates and removes its own temporary SQLite store and contact-window file. The delivery pump, IPC responses, runtime bindings and notifications are inert. Identities are synthetic; no vendor CLI, network adapter, terminal, live Fleet configuration or real person is involved. Admission success is not terminal-delivery evidence.

Run from the repository root with dependencies installed:

```sh
node --import tsx docs/evidence/cross-instance-lock-m3315/probe.ts
```

Observed final run: exit 0.

| Probe | Result |
| --- | --- |
| Six source/target identities, all distinct directed pairs | 30 pairs |
| Five tools per pair through actual Fleet IPC dispatch and SQLite admission | 150 accepted, queued |
| Nonmember selecting another team's broadcast | Both team members admitted |
| External-session alias | Host resolved; admitted |
| Open Hub window | Five peer tools refused; legitimate bound Hub answer accepted; forged correlation refused |
| Incoming send to Hub-restricted agent | Admitted |
| Window reaches 30 minutes | Outgoing send admitted |
| Minimal profile | Send admitted; four other tools refused |
| HTTP operation dispatcher | Five tool admissions |
| 12,289-byte body | Refused before admission |

The first probe run exposed an incomplete synthetic General runtime binding, which correctly returned its existing location/start hold. The harness then explicitly supplied an empty healthy binding read; no product source changed. This is an operational hold, not an incoming allow list. The Hub-report stub tests routing selection, not the full Hub protocol; the neighboring suites below exercise the existing implementation.

Focused regression command:

```sh
node_modules/.bin/vitest run tests/hub-contact-limit-3160.test.ts tests/tool-permissions.test.ts tests/delivery-forwards-1756.test.ts tests/hub-classic-share-m3285.test.ts tests/outbound-fire-and-queue.test.ts --maxWorkers=1 --no-file-parallelism
```

Observed: **5 files passed, 170/170 tests passed**, 16.38 seconds. The initial invocation used an unsupported `--minWorkers` flag and exited before tests; the corrected invocation above is the measured run. Only the existing punycode deprecation warning remained.

The suites cover the real durable forwarding store (including denied/undelivered references), socket/token profile boundaries, Classic room privacy through Hub turns/restart and contact expiry, Hub contact windows, and queue/size semantics. No claim is made about new target policies: this branch adds a design and a probe only.
