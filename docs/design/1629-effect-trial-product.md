# #1629 explicit local-admin Try in the product

> Current policy: [#2118 default playback](canvas-worker-default-playback.md#immediate-startup-and-live-reference-pr-3-of-3)
> supersedes this slice's empty-page calibration and hard OS-motion/Save-Data prerequisites. The original evidence below
> describes that earlier slice. Playback now starts while the host learns a live cadence; the shared device motion option
> is off by default. Isolation, protected pixels, caps and sticky safety remain.

`preview_web_effect({id})` offers a card in the calling agent's web chat. It uses
that agent's current own/shared read access and the one Fleet Trial authority;
it is not an appearance write, does not record a limiter change/upload, and never
starts a browser. Lock and agent-edit rules still govern actual appearance
writes. Repeated active offers reuse their deadline; if their old memory card was
evicted, the same still-valid offer can be displayed again without extending it.

## Host publication and volatile history

Only `WebChatHistory.recordEffectTrial` creates interactive metadata. It fixes the
role/sender itself and validates/copies the closed offer. Generic record/SSE
paths drop effectTrial even when supplied sender/role strings look like the host.
The dedicated publisher emits the recorded status row with its ordinary cursor;
it never emits an agent-reply pulse. Offer rows are omitted from disk persistence,
and restore still strips injected metadata. In-process history/reconnect may show
the card while authority remains volatile. No reply-button DB/route or agent input
is involved.

The renderer escapes the title. DOM attributes contain only the ordinary message
key. Admission requires a real trusted click on the exact current host-created
button, a current checked message and a fresh offer, then the bridge independently
checks the signed-in local-admin display hint and playback gates. Expired cards
update in place without a new SSE event. Public link/View/header/poll pages have
no controls or app owner. Nothing is inferred from a web display name or an agent's
text. Server authorization remains authoritative for every Start and resource read.

## Captured Chat, route, panel and session

The existing app owner owns one control lane and the one shared effect runtime.
An explicit click captures the Chat contribution, navigation sequence, instance,
document, epoch and panel claim before any await. Navigating, replacing the Chat
or its store, closing/replacing the claimed panel, blur, hidden state, auth end,
effects opt-out, reduced motion, save-data or another menu/dialog ends it. HTML preview consent and the owner-CSS lifecycle do not gate the isolated Trial.
A same-name replacement cannot inherit an old click. No logical cancellation
releases an outstanding physical session read/fetch/body/cancel operation.

A checked current Start opens the existing PreviewPanel component slot in Trial
mode. It gets no HTML run token and never calls HTML Preview start/reload/Allow.
The real fixed EffectTrialPanel creates its branded stage, and the app supplies
that stage to the private Trial source. It uses manifest defaults. All regions are
bounded visual samples here; it is not a claim about their eventual page position.

The controller, source, stage and common registry each retain their existing
current/deadline checks. Request-entry monotonic time plus remainingMs is the
lease bound. Late valid replies only receive best-effort Stop. A source refusal
or late stage callback disposes that stage and closes only its own panel. Cleanup
publishes the new/empty panel ownership before calling old callbacks, so reentry
cannot close a newer HTML or Trial panel.

## Paint, capacity and saved state

The existing stage proves contain:paint, overflow:clip, exact physical geometry,
trusted host stylesheet and the fixed direct-child topology before painting.
It lives inside its own panel/sheet, never a portal or a new overlay. There is no
focusable mod document or expanded pointer authority. Ordinary foreground effects
stay suppressed while the Trial panel is visible. The local-admin click supplies sample-specific consent.
Trial chrome and stage use a closed shadow root with a fixed same-origin stylesheet, no parts/slots, and reset inherited font/color/direction.
Owner CSS remains active elsewhere, including the unchanged agent-front suppression rule. Unknown/missing shadow styles refuse paint.

Trial uses the same settled resource lane, registry, standard/constrained caps,
relative host-baseline profiler and mandatory safety history as Chat/personal
placements. Its diagnostic samples stay transient. There is no saved placement,
claim, preference, share, export or new saved diagnostic record. A Stop response
is not a grant and is never parsed. Automatic Stop does not slide idle expiry;
its CSRF/Origin/local-admin/session/epoch checks remain unchanged.

The protocol-double unit tests prove host control ownership and dispatch, not
native clipping or real login. Browser validation must exercise the real product
card click, component slot, controller, source and shared Worker runtime with the
actual private session/Start/Stop handlers. Linux WebKit remains distinct from
real Safari, and no hard real-time cutoff is claimed while the host is blocked.

Rollback is the product integration commit: the existing Chat, personal slots,
cursor, library and safety stores remain usable; the private Trial foundations
remain inert without this card/bridge publication and do not require migration.

## Click consent and owner CSS (#2039)

Try does not use the HTML preview origin's global opt-in as its consent gate. The
local admin's explicit, trusted, current keyed-card click produces the trial
receipt. Listener/boot transport readiness is checked separately; ordinary effects
and cursors still require their original preview consent. No preference is forced
on, and a live Trial cannot lend consent to another descriptor.

The Trial panel's own chrome and canvas stage are inside closed Shadow DOM. Its
fixed self-only stylesheet exports no parts/slots and resets inherited font,
color and direction. An important host reset also blocks direct outer host hiding
and pseudo-element relabeling. Missing, replaced or overdue styles fail closed
before a stage receipt; existing ancestor paint/geometry checks still apply.
Owner CSS remains active for ordinary UI outside this panel. Refusal cards show
one condition and a fixed host action; pending session verification is inert.

The product recipe runs with HTML opt-in false and the session's never-preview
flag true, and proves those choices remain unchanged. It loads real hostile owner
CSS (`::after`, zero font size, display/visibility/opacity hiding, `:host`, `::part`
and inherited font/color) and checks the resulting controls while a real Worker
runs. Browser sessions are minted private fixtures, not a real-login proof. The
separate stage recipe deliberately oversizes the iframe and samples protected
control/clip-edge pixels. Linux WebKit is not real Safari.
