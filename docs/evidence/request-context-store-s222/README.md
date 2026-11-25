# Slice B: immutable context and operation evidence

The new flow stays OFF. No production caller uses the scoped admission port and
ordinary startup creates no companion schema. See the
[design](../../design/request-context-store.md) for scope and rollback limits.

`tests/request-context-store-s222.test.ts` exercises the actual DeliveryOutbox and
SQLite write boundary. Controls cover exact immutable context and operation
identity; source/target incarnations; actor/ingress/evidence/audience changes;
canonical JSON retry; single-parent inheritance; missing/DAG parents; independent
roots; legacy/scoped retry separation; corrupt or missing metadata and delivery
references; payload corruption; insert failure and competing writers. Rollback
also asserts that no working-reference observation escapes before commit.

The process-exit controls run `tests/fixtures/request-context-s222/crash.ts` under
Node with tsx against an owned disposable outbox. The before-commit fixture exits
inside the actual companion INSERT trigger. Reopening sees no context, operation
or delivery, and retry inserts once. The after-commit fixture exits without an
acknowledgment. Reopening sees the committed records and retry returns that same
delivery without another insert. These are SQLite process-crash tests, not a
power-loss or full Fleet-launcher claim. They start no backend or network service
and use no real credential or message.

Sanitized counts and mutation results are in `verification.json`. Raw logs stay
private because neighboring tests can print machine-specific logger fields.
Reproduce the focused controls with:

```sh
npx vitest run tests/request-context-store-s222.test.ts
```

Source and test TypeScript are checked separately. Full repository tests remain
CI's responsibility. No existing UI capture or native/provider campaign is repeated.
