# Directory controller owner lifetime

FleetManager previously retained the first successful AD controller Promise forever. Its owner proof names the exact runtime object and Hub identity; after either changes, that controller correctly refuses but every later request receives the same expired object until fleet restart.

The getter now remembers the controller's existing owner proof. A valid owner reuses its shared controller. An expired owner is fenced synchronously, then its physical work is drained before clearing the old cache. The clear compares the exact old initialization Promise, so concurrent callers cannot discard or duplicate a successor. The next initialization retains the existing shutdown/import checks, shared writer and dynamic mounted source. Stop clears the stored proof in its existing synchronous section; no new early shutdown await is introduced.

Run from this checkout with installed dependencies:

```sh
npx vitest run tests/hub-settings-fleet-m2682.test.ts tests/hub-directory-settings-control.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/hub-directory-control-lifetime/verify.py
```

The mutation command changes one site at a time, requires assertion failures and restores source on every path. Never run it beside tests, type checks or source edits. Evidence uses digest-first mappings. Private logs are under `.artifacts/hub-directory-control-lifetime/`.

Scope: real FleetManager and sealed scratch config, with recorder runtime and controller doubles for owner replacement/held physical drain. The existing actual control suite separately covers permanent fencing and physical directory occupancy. The Stop case sets the real manager's stopping state during a held drain; it is not a full fleet shutdown or native/live operation. No directory request, new writer, migration, browser/PNG/SKEW or UI claim. This does not add cold off/held AD source access.

If old physical close fails, replacement remains refused until cleanup succeeds. Reverting the getter restores the old liveness defect without changing durable Hub state; no SQL/floor/epoch rollback is needed or authorized.
