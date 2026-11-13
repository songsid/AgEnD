# Role audit metadata before activation

The accepted roles design gives `audit.view` a metadata-only read path. The
existing auditor flag also allows encrypted conversation reads, so assigning
that flag to a role holder would exceed the role's authority. This preparation
keeps those two paths separate.

`GET /hub/v1/audit?view=metadata` requires a current named `audit.view` operation
permit from the canonical roles image. Other split management permissions do
not imply it. With roles off, only the configured root retains management
authority. A legacy group-policy image does not expose this selector, even to
the configured root. It returns `not-found`; no legacy content rights change.

The response contains only `id`, `sequence`, `at`, `actor`, `action`, `result`,
`policyVersion`, and optional `fleetId`, `exposureId`, `ownerAtEvent`. The SQL
query selects exactly those columns. It never selects payload references,
private diagnostics, message or room identifiers, grants or code identifiers;
it never decrypts content or creates an auditor assignment. Strict actor and
row validation refuses unfamiliar shapes rather than expanding the projection.

The read records `audit.metadata-read` with the actual acting person before
returning records. That append and the query share the existing immediate SQL
unit. The exact operation permit is checked at its end, so loss or expiry
during the required append rolls back the append and withholds the snapshot.
The returned snapshot retains its proof for the HTTP handler to check after
its final await. Permission restoration does not revive a retired operation.

Pages contain at most 500 records in sequence order. Existing optional
`exposureId` and `after` selectors are validated, captured and parameterized.
This page bound follows the current audit reader. It is not a new retention
policy or an unbounded export endpoint.

The `role-audit-metadata-v1` session/mount capability is advertised only when a
current canonical roles classifier and the composed management authority are
available. This is availability information, never permission: every read
still obtains its own current permit. A future client must detect this feature
before sending the selector. Existing clients omit `view` and keep the exact
owner/auditor reader and response shape. Unknown `view` values are invalid;
they cannot fall through to the content-capable reader. There is no client,
asset, string or UI change in this slice, so no PNG/browser SKEW claim applies.

This is preparation on the unactivated parent chain. It performs no startup
cutover, schema registration, role assignment, directory save, host-owner
address change, member authorization or stream integration. Those remain
separate S-129 acceptance. Tests use actual sessions, roles, SQL and audit
encryption with fictional directory responses and owned loopback HTTP. They
do not claim a production sealed Hub, browser, container, real directory,
account, backend CLI, live Fleet, native OS or pilot operation.

Before activation, reverting this preparation removes the selector and
capability while leaving the old audit reader unchanged. Role activation must
stay off with that rollback. After activation, authorization changes require
reviewed forward changes; never restore an old policy or authorization floor.
