# #1629 volatile Trial offer display

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This introduced the chat metadata and inert offer card. Product integration now uses the dedicated host publication seam and an explicit local-admin click; the authority, local-admin API, host stage and common registry retain their reviewed boundaries.

## Transport and disk boundary

`WebChatMessage.effectTrial` is a separate closed display object:
`{v:1, offer, id, title, expiresAt}`. The server and browser independently validate
own enumerable data properties, 32-character lowercase hex identifiers, a safe
nonnegative expiry, and the same NFC one-line title contract (1–40 graphemes,
400 UTF-16 units). They copy and freeze the result without invoking accessors.
Only an internal `role:"status", sender:"agend"` message with a bounded instance
name keeps this field. Neither text nor an ordinary agent/user message can
promote itself to an offer. These host fields select presentation, not authority.

Fleet SSE and in-process history/replay preserve that checked object. The disk
projection deliberately omits it. Restoring a row with injected metadata also
drops it; a restart never revives an offer. Replay does not renew authority or
expiry. The bounded display object contributes no message content to effect
events and creates no agent-reply pulse or reply-button state.

## Inert protected card

The real thread renderer escapes the title and two localized host labels. The
card has no resource URL, token attribute, action, focusable element, iframe,
canvas or Worker. Public-link readers can see the same local-admin explanation;
they gain no start/read capability. Expiry is display metadata, never a client
clock authorization decision.

The fixed `.shell .thread .effect-trial-offer` selector independently requires
`data-trust="thread-control"`. The root and descendants join the existing
protected-paint union. Removing or changing that marker refuses stock coverage;
no new trust category, global foreground exemption or modal exception is added.

The checked-in stock-native recipe renders the actual Shell, ChatPanel and
thread using private HTTP fixtures. It compares three card pixels under the
existing host red-canvas foreground probe and tests missing/wrong markers. It
is not a product session, authority, Worker, or durable safety-store proof.

## Subsequent integration

Before enabling the preview callback or a Start control, the product integration
must issue offers from the authority against the origin agent's current rights,
publish only newly created offers, and apply the existing appearance policy.
An explicit current local-admin click must start via the authenticated API,
then own a session/epoch-bound source in the existing app registry. The Start
request's monotonic entry time plus `remainingMs` bounds the client lease; late
responses must be stopped without mounting. All approved blur/navigation/dialog,
CSS, expiry, physical clip, shared caps/profiler and safety-stop rules remain.
No diagnostic persistence, placement, claim, preference, export or share side
effect is granted by this display foundation.
