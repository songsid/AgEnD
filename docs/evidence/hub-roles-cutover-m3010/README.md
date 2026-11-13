# S-128 acceptance evidence

The receipt binds six source/test/helper files by SHA-256. It describes an **unmounted** implementation, not a runtime upgrade rehearsal. Source-boundary details and deferred activation contracts are in [the design note](../../design/hub-roles-server-cutover.md).

Reproduce (start only below host load 10):

```sh
node_modules/.bin/vitest run tests/hub-roles-cutover-m3010.test.ts --maxWorkers=2
node_modules/.bin/vitest run tests/hub-roles-{model,evaluate,delegation,convert,change,writer,expiry,cutover}-m3010.test.ts --maxWorkers=2
GOMAXPROCS=2 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
```

Initial exported stubs returned unavailable and a constant inventory digest. The first run had four assertion failures: three state conversions expected `ok:true` but received `ok:false`, and changing an actual enrolment-code counter failed to change the constant digest. These were semantic assertion failures, not missing imports or type failures.

Each receipt mutation records an exact single replacement and selected test. Independently apply one, run the native source typecheck (expected exit 0), then the selected test (expected assertion failure), and restore the source before the next mutation. All fourteen were run separately, compiled, failed semantically and were restored. Logs remain in the author's owned `.artifacts/roles-cutover-m3010/` directory; the final acceptance comment names the submitted SHA and CI separately.

The eight process cases use real SIGKILL of an owned Node fixture and reopen the private WAL database plus fsynced independent floor. Before-floor interruption preserves readable old state; raised-floor/precommit interruption leaves old SQL held; postcommit interruption preserves one completed cutover or mode change. No real service, fleet or host process is killed. Session and directory boundaries in the mode crash worker are inert, as explicitly recorded.
