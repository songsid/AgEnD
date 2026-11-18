# Classic contact authorization server evidence

Date: 2026-11-19. Scope: A1, server admission, persistence and API contracts.
All fixtures are synthetic, with local SQLite, inert peer delivery and fake channel
adapters. No live Fleet, account, platform connection or visible browser was used.
The dashboard implementation and real CLI launch guard are separate follow-ups.

## Regression controls

The four `classic-contact-*-3339.test.ts` files exercise actual outbound handlers,
FleetManager admission and final handoff checks, the shared outbox transaction,
HTTP validation, file snapshots, and history restoration. They cover:

- All five contact verbs held before delivery; separate broadcast outcomes.
- Approval admits the exact retained payload once; decline, expiry, stale revision,
  unauthorized identity and transaction failure admit nothing.
- A matching correlation alone never grants a return. The original approved work
  must have reached its recipient, with both instance incarnations still current.
- Standing grants consume uses atomically and cannot survive instance replacement.
- Origins persist across retries and restart; admin input does not erase the union.
- The Hub contact window wins before application creation, approval and final input.
- Token-only, guest and unverified sessions cannot decide applications.
- Both HTTP and direct IPC enforce the restricted AgEnD tool ceiling.
- Room routing ignores caller chat, thread and adapter overrides.
- Owner files, other-room files, symlinks and hard links are refused before any
  platform post. Allowed files are snapshotted before asynchronous sending.
- Received file identifiers do not carry into a replacement room.
- Existing rooms remain legacy; newly registered rooms persist restricted mode.
- Contact badges and later delivery state survive chat history restoration.

Removing the application admission gate makes the four point-send and broadcast
hold assertions fail: they observe ordinary delivery instead of a held application.
Removing the allowed-root fence makes the owner-file rejection fail. Both changes
were restored. These are behavioral red/green controls, not real-account probes.

## Validation

Commands (run from the repository):

```sh
npx vitest run tests/classic-contact-auth-3339.test.ts tests/classic-contact-dispatch-3339.test.ts tests/classic-contact-api-3339.test.ts tests/classic-contact-files-3339.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck -- --pretty false
npm run typecheck:tests -- --pretty false
```

New focused tests: 32/32. The final focused family passes 323/323 across 20 files.
Source and test typechecks pass. The existing Hub contact,
Hub/Classic privacy, channel reply files, chat persistence, permission sinks,
Classic behavior, Needs you and outbound delivery neighbors were also checked.
The two old privacy tests now wait for the actual channel response, which includes
asynchronous attachment validation; their privacy assertions are unchanged.

## Limits and rollback

This is a contact admission boundary, not an action authorization or OS sandbox.
The owner's standing credentials and prior conversation memory are not removed.
Native coverage stays `not-covered` unless the separately supplied launch guard
proves otherwise. A contact approval never authorizes the worker's subsequent
shell, data access or changes. `/clear` is not claimed as a proven origin reset.

Storage is additive on the existing private outbox connection. Older builds ignore
the new tables and Classic field, so a code rollback removes these controls rather
than preserving restricted behavior. Keep the private database for audit and stop
restricted-room traffic before reverting to a build without this admission gate.

## First CI delta

The first full CI run exposed outdated fixtures outside the initial focused set
and a real Telegram forum regression. The nine failing suites were all rerun in
full, together with the four new suites: 339/339 across 13 files.

- The old Classic address matrix explicitly selects legacy mode. It continues
  to assert the pre-existing routing contract; new-room defaults are pinned in
  the separate restricted tests.
- Borrowed FleetManager methods now have their real contact-service seam, and
  the synthetic native outbox has the corresponding origin read. Ordinary
  non-Classic forwarding and native generation checks remain covered.
- No attachment ID metadata is added to general agent input. Restricted Classic
  thread and attachment identity are captured privately at the shared native
  forwarding ingress. The Telegram topic test caught the missing command path;
  that path now retains its transport topic without accepting caller overrides.
- Concepts and its built-in skill are synchronized; the create-handler test pins
  the new internal origin argument, and the reply bookkeeping stub returns its
  promised asynchronous result.
