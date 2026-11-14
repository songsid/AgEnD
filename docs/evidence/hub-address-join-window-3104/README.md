# M-3104: address-change join window

Issued and acknowledged company joins block address changes until their original `outerDeadline`. That refusal previously became the same `busy` code as a pending writer or full draft queue, so neither address card could explain the wait. Both decisions now translate a dedicated join-window error to HTTP 409 `joining` with the latest blocking `retryAt`. Ordinary busy cases remain separate.

Both real card clients preserve the timestamp. The cards use the agreed English/zh-TW text, format the viewer's local hour/minute, and round the displayed minute up so it cannot suggest retrying before the exact deadline. Missing or invalid time uses the agreed few-minutes fallback. A rejected confirmation returns to editing with the typed address retained; the consumed prepared reference is discarded.

The reported hour was an estimate, corrected by the rehearsal owner. Preserved timestamps are ten minutes apart: join A 03:00:53.631Z → 03:10:53.631Z, join B 03:01:13.088Z → 03:11:13.088Z. The address retry succeeded at 03:11:46Z, after both deadlines. No clock offset was present. The fixed ten-minute lifetime and acknowledged-delivery retention are unchanged: a successful acknowledgement response may still be lost before the Fleet receives it.

Validation:

- Before implementation, the selected new expectations failed semantically: 18 failed, two ordinary-busy transport controls passed, 60 skipped.
- `env TZ=Asia/Taipei GOMAXPROCS=2 nice -n 10 node_modules/.bin/vitest run tests/hub-web-address-decision-3428.test.ts tests/hub-member-address-decision-3429.test.ts tests/hub-web-address-ui.test.ts tests/hub-member-address-ui-3429.test.ts tests/hub-address-join-window-http-3104.test.ts --maxWorkers=2` — 80/80, five files. Real SQLite decisions cover the latest deadline, refusal before it and success at it; real card/client tests cover both languages, local time and retained input; actual HTTP adapters use inert owner/control ports.
- `env GOMAXPROCS=2 nice -n 10 node_modules/.bin/vitest run tests/hub-skill.test.ts tests/hub-enrolment-code-http-b1.test.ts --maxWorkers=2 -t 'hub skill|Hub skill|original issued window'` — 10 pass, 24 skipped. This includes the existing raw backpressure compatibility check.
- Native `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p tsconfig.test.json` — both exit 0.
- `node scripts/changelog-assemble.mjs --check` — 480 fragments OK; `git diff --check` — clean.

No browser matrix, mutation campaign, live rig changes or migration. Logs remain under the author's private `.artifacts/3104/`. Rollback is a code revert; no stored state is rewritten.
