# #1629 explicit local-admin Try in the product

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
opt-out, reduced motion, save-data, unknown CSS or another menu/dialog ends it.
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
stay suppressed while the Trial panel is visible. Custom CSS on/loading/unknown
refuses Try even where an ordinary human placement would retain an exemption.

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
