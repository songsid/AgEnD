# Retained administration authority before role activation

The session slice distinguishes a current administrator from an ordinary person,
but its returned actor is an identity, not an operation permit. Overview,
administrative exposure freeze and This Hub/rename previously discarded their
permission proof after authenticating that actor. This preparation retains a
named `hub.admin` proof until the last protected read, write or disclosure.

The accepted mapping keeps these operations with `hub.admin`. A holder of only
`fleets.manage`, `join.manage`, `roles.assign` or `audit.view` does not inherit
any of them. Fleet revocation's existing `fleets.manage` path is separate. The
owner's narrowing-only exposure freeze stays independent of administration.

Overview builds its metadata projection in one actual SQL unit, checking the
same captured permit before and after it, and immediately before disclosure.
Administrative freeze checks the named permit again after its row update and
required audit inside the same transaction. Authority loss or expiry rolls
back the row, pause epoch and audit together. The operation records the actual
auxiliary actor; it never rewrites that person to the configured root.

The This Hub adapter optionally consumes the composed named proof. An older
standalone adapter without it keeps its previous administrator/session gate.
The composed route always provides the proof. Reads, prepared references and
rename results recheck it after asynchronous or reentrant work. A permanently
retired request cannot regain validity by restoring its provider or session.

Rename continues through the same sealed-settings writer, reference and journal.
Its current callback now includes the operation proof, not only a session-row
check. Required held audit is followed by a new proof check before calling the
writer; the writer also checks it after staging and immediately before its
commit point. Revocation before that point cancels staged files and leaves
the old name/manifest intact. After that point, forward-only installation and
recovery complete the committed decision without obtaining fresh permission.
If authority is lost during the completed audit, the change remains committed
and its receipt remains valid, but protected response metadata is withheld.
That refusal never licenses an automatic retry of the write.

A named proof that fails after an awaited eligibility read rechecks the real
session when its synchronous fence is gone. Real sign-out retains its 401
response. A stale injected reader returning the old actor still rethrows the
original refusal; it never returns a permission or protected view.

The generic SQL unit only needs an `assertCurrent` method. Its parameter accepts
that shape instead of conflating management proof `source: roles` with the
operational resource provenance union. No provenance vocabulary is widened.

This slice adds no role startup migration, policy writer, audit-content right,
directory-save authority, host-owner address capability, member lease, stream
or activation switch. Other administrative adapters, metadata-only audit access
and final member/stream integration remain on S-129. Configured-root repair
and the existing host-owner D3 address route are separate and unchanged.

There is no UI, string, asset, protocol, schema or configuration change. Cached
clients use the same endpoints and JSON result shapes. Healthy legacy root
administration and owner narrowing retain their current behavior. New role
composition remains held behind the parent-first review and activation work.

Verification uses actual roles/session/SQLite components, loopback HTTP and the
real sealed rename writer with generated keys in owned scratch directories.
The directory and configuration save are synthetic. No real AD, account,
backend CLI, Fleet, browser, container, native OS or pilot operation is claimed.
Each claimed mutation must compile and fail a semantic assertion, then restore
exact source. Earlier fixture/import/type errors are excluded from fail-first.

Before role activation, reverting this slice restores the prior actor-only
administrative paths and must also keep role activation off. After activation,
rolling back authorization semantics requires a forward reviewed change; never
restore an old policy or authorization floor.
