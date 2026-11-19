# Classic contact authorization integration

Date: 2026-11-19. This final slice starts from the actual merged A1, A2 and A3:

| Slice | PR | Merge |
| --- | --- | --- |
| Server admission, origins and applications | #4194 | `4244a51e39dd7209972d39bd7c514a4b03d646fc` |
| Dashboard permissions and authorizations | #4196 | `0db8491f3bd958771c7e97cd6ec7d92bd0a1b9eb` |
| Verified native CLI guard | #4195 | `6a8ab730cf984971ca4c85204c985f643bf9d153` |

## Native start disclosure

The web panel, new-room defaults and suggestion already explain the coverage
fallback. Native commands also need this before the restricted default is saved.
The Telegram direct `/start BACKEND`, backend chooser and Discord start choice
now disclose that launch verifies coverage. An uncovered tool or version keeps
its normal permissions, with only contact approval applying. This remains an
advisory message and adds no approval step or unsupported-backend refusal.

Two real Telegram SDK dispatch regressions failed before the change because no
notice preceded room registration (EN and zh-TW). They pass with the change.
Four additional tests pin the same ordering in the Discord choice and backend
chooser for both locales. Existing bot-scoped dedup assertions still require
one registration; a successful direct start now sends its disclosure and reply.
Unauthorized callers continue to receive only their refusal.

The initial native-start family passed 536/536 across six files and TypeScript.
That check used the installed bundled tmux path as an explicit override because
the scratch checkout has no installation receipt; its startup test keeps every
process and tmux boundary inert. No server or pane was opened.

## Combined validation and retained evidence

The combined focused run covers the native start, application store/service/API,
file broker and routing, configured approver refusal, dashboard UI, native guard
and the existing Hub contact/privacy boundaries. Source and test TypeScript are
checked on this combined tree. Result: 151/151 tests across 15 files; source and
test TypeScript both pass.

The 41 isolated CLI observations are retained from
`docs/evidence/classic-cli-guard-m3339/`. Dashboard captures and their real-app
smoke remain in `docs/screenshots/contact-auth-3339/` and
`scripts/manual/smoke/smoke-contact-auth-m3339.mts`. This slice does not claim a
new CLI or browser matrix. No live Fleet, account or visible browser was used.

## Scope and rollback

Dispatch approval retains its A1 scope; it does not authorize the recipient's
subsequent data access, shell commands or changes. Native denial applies only
where the A3 launch guard verifies coverage. The established unsupported-path
warning remains visible; prior memory and same-user processes remain outside
these controls.

Reverting this final slice removes the native pre-start disclosure while leaving
A1 admission, A2 controls and A3 coverage unchanged. It adds no schema or storage.

## Memory-pressure reply ordering

The existing memory-hold test assumed no earlier Classic reply. It now explicitly
expects the pre-start disclosure, one memory-hold notice while admission is
blocked, then the completed status retaining the disclosure. Both locales still
assert zero operation calls while held, one operation after recovery, one hold
notice and no unrelated chat broadcast. The full failing file and both native
start neighbours pass 38/38 using fake time. No runtime behavior changed in this
correction.
