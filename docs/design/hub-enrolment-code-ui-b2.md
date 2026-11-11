# Hub join-code UI (B2)

Implements the Phase B UI in `hub-ux-simplify.md` (public spec d015e6ce, #3658).
The server implementation is #3673. This branch composes the complete public U2
administrator card at c89dd65f (#3698) over that source. Landed dependency sync,
final browser evidence and combined acceptance remain pending.

## U2 mounting contract

U2 owns `#hubEnrolmentCodeSlot` and lazy-loads `./hub-enrolment-code.js` only when
the signed-in session advertises `enrolment-code-v1`. It mounts the exported
`HubEnrolmentCode` only with `enrolmentCodeV1 === true`.

Props are `{ client, enabled, host, onChanged }`. `enabled` means company join is
on (step 1), so a first code can be created without an allowed group. U2 gates its
own step-3 instructions on steps 1 and 2; a newly created live code satisfies
step 2. `onChanged` asks U2 to refresh after a successful create or revoke.
Turning creation off preserves the code list and narrowing revoke action.

The component adds no card frame. It uses the shared Dialog, fields, button rows,
Skeleton, ErrorState and Empty. All copy is registered in its own EN/zh-TW module.
The group picker is U2's optional `hub-group-search.js` with `groupSearchV1` and
`groupSearchIdV1`. B2 uses a separate input/note id so the dialog does not reuse
the policy picker's id on the page behind it.
A chosen DN is resolved again through the existing resolver before the exact
realm/GUID/DN enters the create body. An absent or held older picker without id
support uses the same DN resolver.

The signed-in session advertises implementation support independently of the
administrator's switch. Public join metadata keeps B1's enabled-only feature:
the Fleet still sends no code when the server does not advertise that path.
Capability markers are presentation only; B1 checks current configured-admin
authority, CSRF and enabled state for creation.

## Code management

Defaults are today, 30 Fleets, the company directory and one Fleet per person.
Maximums are 200 total and eight per person. No create happens on entry or on a
retry of a failed read. An uncertain write is followed by a read, never an
automatic repeated write; the create form closes and requires an explicit list
check before another create. Revoke remains the existing idempotent operation.

Only live codes render their text or copy action. Code text stays in mounted
memory and the clipboard after an explicit press; it is never put in a URL,
browser storage or an error. Names and directory results render as text. The
list polls every five seconds while visible, with one read at a time. Older
reads cannot restore a revoked code after a write. Session end clears codes and
retires held callbacks; client changes also fence rendered snapshots.

## Approval queue

`hub-join-queue.js` captures one request id, CSRF and immutable outer deadline.
It sends an initial approve plus at most eight retries with 2–6 second jitter.
Only backpressure retries. Limit, offer-pending, permission, expiry and transport
refusals retain their meanings. A local deadline is **unverified**, never proof
that nothing was issued; the existing browser projection supplies that result.
Even a stalled fetch cannot hold the local queue past its original deadline.

`hub-join-approval.js` binds the queue to a mounted request/session lease. Its
first finite outer deadline stays pinned through temporary browser-projection
errors; later reads cannot extend it or retire a still-current approval. Both
the already-signed-in Hub page and approval immediately after company sign-in
use it. The queue does not repeat company sign-in. Concurrent presses share a
flight; manual retry after the last busy answer repeats the same request.
Retirement clears timers, settles the local promise and aborts when available;
generation/current checks also discard late results without AbortController.
The queue grants no enrollment authority; every approve still reaches B1.

## Notice compatibility

An upgraded renderer explicitly requests notice v3. A cached renderer calling
the upgraded client without a version keeps v2. The upgraded client also requires
the current signed-in server capability before requesting v3, so a new renderer
with an older server stays on v2. Code rows have their own approval copy rather
than the group-policy label. Current member Settings takes a version-3 reader
lease only alongside the renderer's `pairingNoticesV3` marker and the optional
client `usePairingNoticeVersion(3)` method. Each lease retires on unmount. Reads
from older lease generations cannot replace the notice snapshot, and the last
retiring reader clears code rows from the local presentation cache.

The member request is `?v=2&notices=3`: a current host recognizes the additive
notice opt-in; an older host ignores it and still returns manual v2 notices.
Old Settings or a held renderer without the marker keeps plain `?v=2`, retaining
code rows until a code-aware renderer is present. No route authority changes.

## Verification and outstanding acceptance

The preparation tests mount production Preact with an inert client/fetch, use
fake timers for the pure queue and use an owned HTTPS/synthetic-LDAPS Hub for the
session capability boundary. Guard reversals run one at a time and restore exact
source bytes. These are not a full container/Fleet/browser acceptance claim.

Before review: plain-merge U2/B1's landed source; recheck U1's connected-tab
closing and refusal vocabulary (preserved in the groundwork merge); run current
and cached shell/CSS SKEW, desktop/phone EN/zh-TW PNGs, and B-L* including the
five distinct Fleet UI and 50-within-five-minutes legs. Do not change the
Fleet input file. Keep the PR held until its dependencies and evidence settle.

Risks are browser timing, stale responses and deployment skew, covered by the
current fences and pending real-browser acceptance. Reverting B2 removes its UI
and capability additions without changing B1's database or issued credentials.
An older notice renderer continues to retain v3 rows instead of acknowledging
rows it cannot label.
