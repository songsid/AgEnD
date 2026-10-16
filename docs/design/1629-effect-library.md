# CW1 library participant (#1629)

This is backend foundation for Canvas Worker effects. It exposes no HTTP route, MCP/CLI tool, renderer or placement authority. The library assumes the fleet's single admitted process owner; it does not replace that process lock or isolate programs with shell access under the same OS uid.

## Authoritative state

- `<dataDir>/web-effects/<id>/`: complete normalized CW1 files, private directory and 0600 files. The upload supplies the bytes; an id alone never claims a blob.
- `web-effects.json`: version 1, increasing revision, full SHA, bounded manifest/path metadata and per-principal claims. The index is atomically written at 0600 only after complete blobs exist. The shared atomic writer now drains a UTF-8 byte buffer across positive short writes before fsync/rename; zero progress or a later write error abandons the temporary file and preserves the old index. Individual files are fsynced; directory fsync is best effort, following the existing atomic writer's portability contract. No power-loss durability across every filesystem is claimed.
- A principal is `{kind: "agent" | "human", id: string}` supplied by authenticated host ingress. Neither an upload manifest nor a request's proposed actor is authority.
- A claim retains an id for that principal with one or more holders: `upload`, or host-only `mod:<32-hex-id>`. A later direct upload adds its own retention even when a mod already holds the same id. One physical blob can serve multiple principals without exposing their claims.
- Only a human can share their own claim. Ordinary list/read sees the caller's claims plus human-shared claims. An agent re-upload does not inherit sharing.
- Quota: ten distinct ids and 8 MiB normalized bytes per principal, regardless of the number of its holders. Staging and commit both check the current quota. Limits are separate from the appearance tool's shared accepted-call limiter, which callers check/record around the synchronous transaction.

Absent index is empty. Invalid, oversized, unreadable or non-UTF-8 index is an error and is never overwritten. Reads and commits verify complete normalized files against full SHA, id, bytes and manifest before returning code or creating a claim. Listing returns bounded index summaries, not a capability or sufficient validation for a placement.

## Participant API

`EffectLibraryParticipant` is a structural type exported by `web-effect-library.ts`; tests can use a fake. It includes these methods:

```ts
stage(filesOrOrderedEntries, principal, {holder?: "mod:<id>"})
  // -> {ok:true,stageId,ids,entries:[{id,manifest,bytes,warnings}]} | {ok:false,error}
commit(stageId)
  // -> {ok:true,ids,created,undo():boolean} | {ok:false,error}
abort(stageId)
releaseHolder(holder, principal)
  // -> {ok:true,released,undo():boolean} | {ok:false,error}
read(id, principal)
readReferenced(id, holder) // internal only, after the route authorizes that resource
registerReferenceSource(name, () => Iterable<{id,holder}>) // -> unregister
```

The mod importer is the only route that supplies a mod holder. Normal tools omit it. `created` lists newly owned ids, excluding ids the principal already owned; it is audit information. Uninstall releases its exact principal + mod holder, not a whole principal/id claim. No cleanup-custody handoff is needed between mods or principals.

An agent's proposed mod stores bytes/card and spends its upload limit at that proposal layer. A person reviewing/committing that card stages under their authenticated human principal. Agent exports use ordinary `read`; an authorized installed-mod export uses `readReferenced` with the exact registered mod holder. Merely knowing a holder/id does not authorize a route. Human stage/commit routes must bind stage ids to their own authenticated plan; commit's stage id is an internal participant handle, not a general user capability.

Stages snapshot normalized bytes and display metadata in bounded memory: at most ten ordered entries, 8 MiB raw bytes per stage, four stages per principal, 64 stages/64 MiB normalized bytes globally. Duplicate ids retain their ordered positions but store one snapshot. TTL is ten monotonic minutes; wall-clock jumps do not renew it. Constructor does no I/O. No stage is persisted: restart returns `unknown_stage`, requiring restage/review. Stage/abort/expiry never grant an index claim.

## Transactions and references

The importer commits the library first, then its own theme/placement/CSS/mod stores, without an await. On a later failure it restores those stores first, then calls the receipt's `undo()` in the same synchronous stretch. Uninstall similarly releases the scoped holder first and rolls it back if a later store write fails.

Undo is single use and expires before the next asynchronous callback. A short-lived Node async-hooks `before` boundary disables itself on that first callback or synchronous undo; a cleanup microtask is also queued. The boundary catches a callback queued before commit, independently of expiry-microtask ordering. It deliberately refuses a synchronous handoff into a different AsyncResource too. This temporarily enables async-hook tracking for the current stretch; it is not a permanent fleet-wide hook. It requires the exact written index postimage and unchanged relevant reference pairs. A fresh write, new reference, unreadable provider or failed rollback leaves state untouched and returns false; the caller logs it and fails the composite transaction. Undo restores the logical preimage with a new revision, avoiding an ABA revision rollback.

Every registered provider must be readable. Providers describe installed mods, instance effect placements and human effect preferences. The library refuses unknown/invalid providers rather than treating them as empty. References are revalidated immediately before index publication, inside the atomic writer's pre-rename fence. Reentrant writes refuse. This assumes host-owned synchronous providers, not arbitrary code from a bundle.

`deleteClaim` explicitly removes the caller's whole unused claim, including orphan mod holders after a failed composite rollback; any reference or live stage refuses it. Installed mods register every retained id, so normal delete cannot remove an installed mod's claim. `releaseHolder` removes only the exact mod holder even when another holder/reference keeps the bytes. `readReferenced` requires the exact id/holder pair from a provider and never broadens ordinary principal visibility.

Known unclaimed/unreferenced blobs are collected after the synchronous transaction, and after a retaining stage aborts/expires. When a host placement/preference source removes a reference, its integration calls `collectUnreferenced(ids)`; that schedules the same guarded collector, never deletes synchronously or grants visibility. The integration must wire this notification before enabling product placement writes. Other claims, providers and stages retain them. Collection rechecks the current index and references; errors leave debris with no placement authority. A crash or filesystem failure can leave unreferenced physical debris; the 8 MiB principal quota is a claim quota, not a hard bound on such debris. This PR adds no startup scan or migration.

## Evidence and rollback

Tests use private fixture directories, fake clocks, failpoints and reference providers; process launch is forbidden. No fleet, account, service, tmux or browser is needed for these backend tests. Runtime browser guarantees remain the separate Worker primitive's responsibility.

Rollback is reverting the feature-branch module and its future integration. There is no product integration or persisted production effect data yet. A production release must not enable uploads/mounting before the caller authorization, quota limiter, caps, trust clipping, event filtering and profiler are implemented and reviewed.
