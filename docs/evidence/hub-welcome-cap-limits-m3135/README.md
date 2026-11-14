# M-3135: receive-first welcome capability bound

Product: ee932dce53b1e024e87d5678c1cb1077a5581940, based on M-3132's adapted7b5870c9eaf5385e4b1940236b7a4d737a64f927. Both cards ship through alpha PR3946.

Welcome parsing previously imposed the same16-name bound on member reception and Hub encoding, because encodeServerFrame calls parseServerFrame. Members now receive up to32 and reject33; the Hub encoder independently keeps16 for older Fleets. Missing and empty optional capability lists remain valid, and no list is truncated. HubServer's HubSocket uses encodeServerFrame, so the real welcome path retains this guard. No feature names, version fields, storage or schema change.

The tests use literal bounds. Receive cases cover absent/empty lists,16/17/32 names and rejection of33. Encode cases cover absent/empty/16 and rejection of17/32. With the original codec, the receive case fails and the send case passes. With only receive widened, the receive case passes and the send case fails; this pins why an independent send guard is necessary. Each fail-first stage has1 failing,1 passing and27 skipped cases. The final complete protocol file passes29/29, including M-3132's hello bounds. Source and test TypeScript programs both exit0;502 changelog fragments validate.

Reproduce with `GOMAXPROCS=2 nice -n 10 node_modules/.bin/vitest run tests/hub-protocol.test.ts --maxWorkers=1`; the two fail-first stages select `-t 'welcome capabilities'`. Types use `tsc --noEmit` and `tsc --noEmit -p tsconfig.test.json`. No new browser, TLS/WSS, vendor or mutation campaign.

Rollback reverts the welcome changes while keeping the hello rollout intact. A later release may raise Hub sends once older Fleets can receive more names. Both directions currently receive32 and send16.
