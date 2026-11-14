# Alpha.4 plain sync

The reviewed R head `dbe23d029b719630e163d207708745b5130f8fc2` consumes C's plain-sync parent `6b80348708cf21aaff4b7fca6a8ce9e0c66e538a`, which contains released alpha `51f14fbd554df1970d1d75e931f938766eb8f900`.

Two adjacent-insertion conflicts retain both the Team mount and incoming server-owned logging: `compose/server.ts` keeps `teams` plus `log` in its dependency interface and factory call; `http/deps.ts` keeps both declarations. All other paths merge automatically.

The original six-file R delta is byte-equal after excluding only diff blob indexes and numeric hunk ranges. Paths, function context and every added/deleted line remain exact. Both complete test files are also byte-identical. Every other original changed path relative to C is already part of the reviewed R PR. `carry.json` records the comparison and exact refs.

No local test, typecheck, mutation, browser or independent campaign is repeated, per decision 5afe2996. Existing acceptance retains its original scope. Fresh exact-head CI and formal re-APPROVE cite “tree unchanged since dbe23d02”; parent-first gating remains required.
