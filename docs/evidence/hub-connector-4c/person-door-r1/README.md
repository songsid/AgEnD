# Person-door review R1

Fable's F1 found that a pure administrator-policy widening disconnected every app. The new positive probe is assertion-red on reviewed `8e236ee6b`: adding another person makes the existing token return 401 instead of 200 (one selected test, 26 unselected). The writer now sweeps current grants only on a possible narrowing while enabled: disable, everyone-on to selected subjects, or removing a subject while everyone remains off. Pure additions, label/order edits and everyone-on preserve existing tokens. The narrowing sweep remains conservative and Hub-wide; a remove/re-add cannot revive an unused token.

The focused door suite passes **27/27** and both source/test TypeScript programs exit **0**. Existing tests still pin disable/re-enable; the remove/re-add case now isolates subject removal, and the new everyone-off case pins that separate narrowing. Runtime changes are confined to `mcp/policy.ts`.

```sh
npx vitest run tests/hub-mcp-door-m3240.test.ts --maxWorkers=2
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
git diff --check
```

Q1 is documentation only: app `room.message`/`question.accepted` audit events intentionally omit content pointers under the step-1 audit privacy rule. Actor, room/message IDs and outcome remain, with content in the ordinary room/question store under existing access and retention. Browser audit behavior is unchanged. The design makes this investigation tradeoff explicit; no audit or retention code changed in R1.

Earlier 114/8, first-stage auth checks and the three guard-removal campaign retain their original source scopes. No repeated matrix, real model, browser, TLS, native or mutation campaign ran for this correction. Draft and third-slice UI/real-CLI holds remain. Rollback uses a compatible policy fix retaining schema/history and the narrowing fences.
