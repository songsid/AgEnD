# Request-based approval enable freeze

The beta.27 rehearsal found that a delivered human request could have its reply
refused before its owned reply route armed, followed by a root that could not
drain. This release keeps L's implementation but refuses every new enable.
The beta.28 repair is tracked separately; this patch does not guess a route or
force completion of existing work.

The production controller publishes `enableUnavailable: true`. Its enable guard
runs before preparation, relaunch or activation. The API also refuses a confirmed
replay with the plain localized reason. The shared Settings effect/proposal path
used by General refuses before creating a pending enable. Input schema does not
let a caller override release availability. Disable, Check and drain resolution
retain their existing paths.

The real Settings component renders an Off, disabled switch and the supplied
reason. An already-On switch remains usable for Off. The text captures were
rendered by that component with synthetic status, without starting a Fleet:

- [English capture](en.txt)
- [Traditional Chinese capture](zh-TW.txt)

Generate and verify the captures with:

```sh
CAPTURE_REQUEST_CONTEXT_FREEZE=docs/evidence/request-context-enable-freeze-s274 \
  node_modules/.bin/vitest run tests/request-context-enable-freeze-ui-s274.test.ts --maxWorkers=2
```

Focused regression coverage includes the actual Fleet controller refusing before
any installer side effect, confirmed API replay, shared General/HTTP proposal,
EN/zh response copy, and both unavailable-On and usable-Off UI states. Existing
full-mode physical-owner proofs explicitly bypass this release guard in their
synthetic fixture; production has no configuration or request override.

Rollback is an independent revert after the real reply/root/drain repair passes
review and the full-mode rig. This patch introduces no data migration. Existing
activated homes are not rewritten, and Off is not bypassed or forced.
