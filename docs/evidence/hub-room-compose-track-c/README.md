# Track C member composition checkpoint

Source `5a493cd9d`, followed by plain sync `95b67d7ba99f0692751fffb9382e39d407108cdf` onto R2 `74018cbf4ba594a4a7b1f4518bc55d8b101752d0`. All ten own source/test/doc blobs are unchanged by that sync. `bindings.json` and `manifest.json` bind the exact inputs and receipts. The unmounted adapter's earlier #3860 packet remains separate.

The actual member factory, private SQLite/floors/keys, pairing replacement and TLS/WSS link run in the tests. Fleet delivery, state and directory callbacks are inert. No agent receives input, no model or real directory is called, and no browser/container is started.

- Fail-first composition: **three semantic reds and one uncomposed-host positive** before the factory wiring, retained in `baseline-before.log`.
- **185/185 in eleven suites before the disjoint sync**, from 175/9 plus a non-overlapping 10/2 supplement. The large run selected the actual nine suites; a mistyped reconnect filename selected nothing, so the real `hub-member-reconnect-network` suite was explicitly run in the supplement with `hub-skill`.
- **25/25 at the synchronized source**, including all nine composition cases plus sixteen R2 dispatcher controls. This is not a repeated 185-test claim.
- Native TypeScript **7.0.2** source and test programs both exit zero at the synchronized source.
- **Seven isolated reversals**, each compiling the native source program and failing by assertion, then restoring exact bytes: composed-only capability offer, exact ACK routing, current consent token, pre-adoption room authentication, delayed input-failure routing, the explicit room offer and fresh approval observation. `mutations/restored.json` binds the restored sources. No survivor is counted as caught.

The nine composition cases cover negotiated ask/report/ACK/presence; an uncomposed host; identical frozen answers across same-binding restart; delayed IPC failure; periodic state and stop; withdrawal/lifecycle changes before input; corrupt legacy history without pairing/floor adoption; and a different complete room set after a guarded re-pair with the old history retained.

Reproduce with `vitest run --maxWorkers=2` (or one file with `--no-file-parallelism`) at host load at most ten. The eleven relevant suites are room-compose-track-c, room-ask-track-c, compose-member, member-repair-3823, member-reconciliation, member-reconnect-network, representative, fleet-hooks, room-link-r2, member-journal and hub-skill, each prefixed `tests/hub-` and suffixed `.test.ts`. Native commands are `node_modules/@typescript/typescript-linux-x64/lib/tsc --noEmit` and the same with `-p tsconfig.test.json`.

This is a draft composition slice, stacked on #3860 and #3863. The shared UI's reason-aware grey Stopped treatment/string and the integrated gallery remain release prerequisites; no PNG or full room-user-flow acceptance is claimed here. Invitation consent, virtual teams and assistant behavior are not implemented in this checkpoint. Coordinator alone gates after ordinary review, exact checks and dependencies.
