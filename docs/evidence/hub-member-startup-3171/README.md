M-3171 fixes a paired Fleet staying offline forever when its first connection attempt happens during a Hub outage.

The first failed dial already schedules a client reconnect. It also rejects `start()`, so HubMount immediately fences
and closes the member, cancels that timer and detaches the local owner APIs. The runtime remembers the unchanged
configuration, so there is no subsequent mount attempt. A Fleet connected before the outage keeps its client and
therefore recovers normally.

The real member factory now opts into `allowOfflineStart`. A retryable first dial or reconciliation failure completes
local startup in the offline state, keeping the existing client's bounded backoff and the local APIs. Online still
means the welcome and reconciliation completed. TLS identity changes, explicit authentication refusals, invalid
pairing/state, and factory/cleanup failures retain their previous refusal paths. Direct client callers do not opt in.
No new retry loop, migration, protocol field, credential or automatic re-pairing is introduced.

`manifest.json` binds the exact product, source and test inputs. Tests ran on alpha `9b241ced`; source commit
`deac341b` includes the disjoint phone CSS/docs alpha sync to `e8003bbd`. Every own source/test blob is unchanged
from product commit `22c1240f`. No local re-run was made for that sync (decision 5afe2996).

| Check | Result and scope |
| --- | --- |
| Original `baseline.test.ts.txt` on alpha 9b241ced | One semantic assertion failure: member becomes held after a refused local connection. `before.log`. |
| Same baseline on released alpha.4 / beta.3 | Both fail at the same hold assertion. Exact release-tag source, real runtime/member factory/TLS/SQLite; not packaged systemd rehearsals. Separate release logs and SHAs are retained. |
| Final focused command below | 42/42 in five files, including seven new startup controls. `focused.log`. Earlier subsets overlap and are not added to this count. |
| Source and test TypeScript programs | No diagnostics; `source-types.log` and `test-types.log`. Native TypeScript compiler, Node 22.22.2. |
| Two isolated reversals | Both assertion-red: disable the factory opt-in; disable offline startup after an upgraded first-link failure. One selected test each, six unselected each. Exact source restored and hashes recorded in `mutations.json`. |

The new controls cover connection refusal then recovery with the same mounted exposure/update controllers; a real
authenticated local owner HTTP consent GET returning 200 while offline; first reconciliation failure; HTTP 503;
terminal 401/403; and switch-off/shutdown cancelling retry before the Hub returns. The wider focused files cover
normal pairing, TLS pin refusal, revoked/replaced links, receipt recovery, partial state refusal and owner update routes.

```sh
npx --no-install vitest run tests/hub-member-startup-3171.test.ts tests/hub-compose-member.test.ts tests/hub-member-reconnect-network.test.ts tests/hub-network.test.ts tests/hub-update-owner-m3144.test.ts --maxWorkers=2
npx --no-install tsc --noEmit -p tsconfig.json
npx --no-install tsc --noEmit -p tsconfig.test.json
```

All files, sockets, certificates and databases belong to local test rigs. The owner HTTP host is a fixture
FleetManager with inert update launch and agent delivery; no running Fleet, real directory, browser or vendor CLI
was used. The stopped phase-3 rehearsal containers were not started. The tests restore the Hub before the backoff
ceiling; long outages use the existing reconnect timer (up to 30 seconds plus its existing jitter), not a new deadline.

Risk: a composed member can now be mounted while its remote link is unavailable. Existing readiness/current-link
checks continue to refuse remote operations until reconciliation. Rollback: revert the product commit's own patch;
there is no persisted-format change. That restores the startup outage bug and does not require deleting member state.
