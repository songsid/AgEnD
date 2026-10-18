# Canvas Worker effects in local Chat

> Current policy: [#2118 default playback](canvas-worker-default-playback.md#immediate-startup-and-live-reference-pr-3-of-3)
> supersedes this slice's empty-page calibration and hard OS-motion/Save-Data prerequisites. The original evidence below
> describes that earlier slice. Playback now starts while the host learns a live cadence; the shared device motion option
> is off by default. Isolation, protected pixels, caps and sticky safety remain.

This slice connects the reviewed B2 components to the committed Chat view on the
2.3 feature branch. It does not mount personal sidebar/header/page/box/cursor
choices or implement the Try side panel. Static public/anonymous posters are a separately reviewed path; this live bridge does not change them. Those personal/Try paths remain
separate B2 work. It changes neither the main branch nor the HTML preview shim.

## Ownership and admission

The app owns one registry/loader for its Window episode, even when Fleet is the initial page. The real `.chat-main` DOM reference and current view lease contribute to that owner; they never construct a second pool.
The immutable server-rendered `data-prefs` supplies a person/operator scope and
session epoch; header-token, public-link, anonymous and View-only loads cannot
construct the runtime. Explicit web-only operator identity remains supported.
Sign-out/session-end observation is registered before construction, including
synchronous replay to late observers. A navigation sequence synchronously detaches the old contribution before lazy panel loading. Route disposal aborts its reads and removes its frames, retaining the app owner and physical reservations; pagehide/session end stops writes, releases global listeners and removes the pool. A BFCache restoration does not
restart the old runtime: reload the page for a fresh session episode.

Static modules contain host code only; reading them does not authorize an effect.
The stock proof fences resource reservation/acceptance and frame admission/reveal,
using the actual registry root and shell geometry. Safe mode, reduced motion,
Save-Data, visibility, browser support, `fx.show`, preview opt-in, the current
preview origin and its session-level Never choice remain independent gates.
Local full-page CSP names exactly the chosen preview `/frame` and `/effect` paths.
Public-link and anonymous/View-only policy does not gain `/effect`; there is no
host blob/Worker/eval policy change.

Theme revisions remove old descriptors before reading the new authoritative
placements. A stale result cannot republish them. One pending metadata operation
coalesces revisions; requests do not poll or retry on their own. An unchanged
explicit Pause survives a revision. Invalid/unavailable runtime resources stop
that Chat contribution without an automatic retry; this conservative rule also
applies to a transient read failure. A newly committed route may read again using
the same app pool. A failed/revoked page owner itself requires reload. No latest-session, general-library or unauthenticated
fallback supplies code. Physical read/write reservations survive logical abort
until fetch/body cancellation actually settles. A new Chat waits for the prior metadata operation’s physical settlement before reading; a stuck operation retains that capacity and requires reload. A stale old success/failure cannot enter the new contribution, even for the same content id. The adapter does not poll or spin up another pool.

## Paint, input and content-free signals

Agent foreground effects remain suppressed while owner CSS is on, loading or
unknown. The existing More menu opens Effects, which explains this in EN/zh-TW
and links directly to Appearance settings. Human provenance retains its approved
exemption, subject to the stock/barrier proof. Behind effects still need stock
ordering; they can tint translucent stock backgrounds, as already documented.
Only agent foreground effects use protected holes. This is not a promise that
behind paint leaves every translucent protected background pixel unchanged.

Pointer forwarding also requires a fresh proof with `front: true`, even for a
behind frame. Thus a newly opened dialog blocks pointer signals before the
adapter's cached modal flag updates. A DOM barrier observer updates that flag on
open/close; the registry's own proof remains the admission/paint boundary.

State is projected to idle/working/needs_you/stopped, theme to light/dark, and
fresh-only reply to an empty signal. Permission text, messages, sender names,
reply IDs and correlation metadata never enter Worker events. Mention stays
reserved and is never emitted in 2.3.0. Untrusted code still runs only in the
Canvas Worker: the document realm contains the trusted shim and canvas, with no
mod-authored DOM or focusable content. Existing ready-only/CSP/second-load rules
are unchanged.

## Human controls and profiles

The existing protected header menu and Dialog provide Pause, explicit Resume,
and (with an admin display hint) Remove from chat. Resume calls the safety
participant; it does not erase probation history or the three-pauses off latch.
The display hint reuses `/auth/session`'s existing cached tier read; it grants no
server authority. A new view lease resets dialog/busy state and fences old
continuations. Removal re-reads authoritative placements after success.

Each actual mount receipt owns a fresh profile collector. Only its current owner
can add or start a report; duplicate/stale profiler windows remain excluded.
The first ordinary report waits ten seconds; a terminal pause may report earlier.
Reports are diagnostic only. Their closed body is sent with the exact session
epoch and instance, through the existing CSRF wrapper. The host consumes no
response JSON and grants no permission from success. Three physical writes per
Window are the upper bound across route writers, with a ten-second logical
deadline and no automatic resend. Retirement can finish an already-started
report, but cannot start another. Route/auth teardown aborts all owned writes.
The server's separate ten-second rate limit may omit a subsequent diagnostic;
local safety history and pause controls remain authoritative.

## Verification limits

Unit controls cover closed identity/gates, generation changes, owner receipts,
physical write reservations, timing, explicit controls and pointer barriers. The
checked-in native recipe uses the actual Shell, ChatPanel, service/library
projection and built preview listener with synthetic identity and private stores.
It runs without external networking or a fleet/account/service. Desktop and
constrained cases set device signals explicitly. Linux WebKit is not real Safari.
No fixture substitutes for server session/CSRF/ACL route tests.
