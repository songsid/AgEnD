# First administrator: designate locally, sign in in the browser

The local `agend hub init` operator selects one directory login. The verified LDAPS
service account searches only the configured user base/filter, refuses zero or
ambiguous results, and rechecks the same immutable ID and enabled status. The
operator confirms the displayed person and `realm/objectId`. Only this key enters
the existing sealed initialization plan. No personal password, browser session or
directory write is involved in designation. Missing lookup support fails closed.

The designated person then opens the Hub web origin and signs in with their own
directory credentials. The existing session checks compare the authenticated
immutable key with the sealed administrator key; other people can sign in but
cannot administer. Renaming the original account keeps its identity; recreating
its old login does not inherit administration. Current directory eligibility is
still checked on every administrative operation.

The first matching successful sign-in appends `administrator.claimed` in the same
transaction as its person and session rows and required sign-in audit. Failure
rolls all of those writes back. The existing person row is the durable witness,
so repeated/concurrent sign-ins do not claim twice. Older installations already
have the same immutable administrator binding and sign-in witness; no migration,
new role, fallback administrator, or automatic reassignment is needed. The audit
event records successful sign-in, not a new source of authority.

The EN/zh-TW wizard explains the separation and prints the browser sign-in step
after initialization. Interrupted initialization resumes the exact saved key; it
does not look up a mutable login again. Browser routes expose no account lookup
or local-host repair login. Validation uses only fake directory people and
private scratch files; the running pilot and its real sign-in are unchanged.

Rollback restores the previous init prompts; already sealed administrator keys
and existing sessions retain their format and authority checks. Audit action
strings are forward-compatible with the existing log.
