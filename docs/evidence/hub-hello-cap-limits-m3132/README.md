# M-3132: receive-first hello capability bound

Product: 8cb9062fbf680c7f24e2d840f216d7f97ab3c08b, based on alpha3abce4026b9b70341cefaf7e2a278b8a4048fe5d.

The hello schema previously limited both Hub reception and member encoding to16 names, because encodeMemberFrame calls parseMemberFrame. Merely widening that shared schema would also relax member sends. Hub parsing now accepts32 and refuses33; the encoder separately retains the16-name bound, including mandatory names. HubMemberClient's handshake uses this encoder. No feature names are added, no offer is truncated, welcome reception remains16, and version-report fields are unchanged. The protocol note states that version reports are values, not extra names.

Boundary tests exercise behavior without importing the numeric bounds: Hub reception of16/17/32 names and rejection of33; member encoding of16 and rejection of17/32. Before the change the receive test fails, with26 existing/negative cases passing. Afterward the complete protocol file passes27/27. Both source and test TypeScript programs exit0; changelog validator passes500 fragments.

Reproduce the focused suite with `GOMAXPROCS=2 nice -n 10 node_modules/.bin/vitest run tests/hub-protocol.test.ts --maxWorkers=1`; type programs use `tsc --noEmit` and `tsc --noEmit -p tsconfig.test.json`. No browser, TLS/WSS, vendor or mutation campaign was run for this bounded codec change.

Rollback reverts the two codec edits and tests; there is no persistent schema or data change. Increasing member sends is deliberately left for a later release after older Hubs can receive them.
