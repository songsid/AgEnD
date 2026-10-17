# #1629 physically clipped local Trial stage

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This is an **unmounted paint foundation** for the approved
[Try policy](1629-effect-trial-authority.md), following the
[local-admin API](1629-effect-trial-api.md). The real app still does not offer or
start Try. The shared stage helper is now a fixed ASSETS dependency of the common registry; the panel module falls under the existing authenticated `/ui/js/` file route but has no product import. See the [registry seam](1629-effect-trial-registry.md). The fixed host `EffectTrialPanel` and `effect-trial-stage.js` create no
request, frame, Worker, registry, profiler or pool on their own.

## Closed local paint receipt

The host producer renders one `aside.pv-panel.effect-trial-panel`, directly inside
the actual Chat split, with the existing protected `preview` marker. It owns the
bilingual Trial label, title, Stop and Close buttons, stage and explanatory note.
There is no portal or overlay added by this feature. The existing preview panel's
phone sheet positioning is reused. No mod HTML, controls or DOM is accepted.

The stage is an empty, nonfocusable, aria-hidden DIV with `contain: paint`,
`overflow: clip`, position relative and local level 0. Host controls own level 1.
The real, loaded same-origin app.css is the only CSSOM write seam. Unknown CSS,
missing stylesheet, transforms, opacity/blending changes, padding/borders or
lost clipping refuse paint. Stage bounds must stay inside the panel and visible
viewport. Width/height are rounded **inward** to integer canvas dimensions;
unsupported/subpixel geometry may conservatively refuse rather than spill.

A nonserializable WeakMap receipt binds the exact host stage, id, instance and
generation. Its frozen public identity is diagnostic, not a serialized grant;
forged, stale or mismatched receipts resolve to nothing. Current lease and CSS-off
callbacks run before and after layout, with disposal/replacement fences.
The stage accepts at most one real effect iframe. It proves initial hiding before
successful bind, checks local geometry before every reveal, and physically removes
the frame when the proof fails. The caller must also remove/close the factory
handle on rejection or stop; removing a DOM element alone is not port cleanup.

The Trial panel is an ordinary foreground barrier at **both** widths: its receipt
never changes stock `front:false` or `agentFront:false` to true. Only that exact
local sample may use the separate receipt, inside the physical clip. All other
visible closed-inventory menus/dialogs stop the sample. Blur immediately invalidates
the receipt; Stop, Close, component unmount and lease loss end it without revival.

## Remaining mount obligations

The common registry must consume this receipt per descriptor, keep original
front/behind declarations for the existing total/front caps, hide/recheck on each
paint/event and invalidation, and retain its normal profiler and mandatory safety
markers/history/latches. There is no second pool or trial-specific safety reset.
An ordinary saved diagnostic profile is not written for Try; this does **not**
waive the shared safety state needed to enforce crash/budget stops.

The future card/driver must require an explicit local admin click, enforce the
request-start monotonic deadline and session/epoch from the API, stop on navigation,
blur or another menu/dialog, and recheck current origin-agent access at every read.
This primitive's `current` callback or receipt is not authentication or consent.
No Try card, tool preview success, public start, automatic start or product mount
is added here. Nothing creates a placement, claim, preference, share or export.

## Evidence and limits

`tests/effect-trial-stage-1629.test.ts` uses modeled DOM/style/geometry to pin
receipts, current/reentry checks, clipping refusal, initial hiding and cleanup.
`tests/effect-trial-panel-1629.test.ts` renders the actual host producer with a
mocked paint owner to pin bilingual controls, escaped text and callback lifetime.

`scripts/manual/effect-trial-stage-1629.mts` uses the actual Shell and Chat plus the
actual TrialPanel through exactly one **private component-slot overlay** (the
production Chat module is not changed). It uses the real factory and built preview
response/Canvas Worker, samples protected pixels, forces an oversized iframe to
prove physical clipping, and tests initial hiding, clip/contain/transform refusal,
CSS on/loading/unknown, stale owner, other dialog/menu, blur, Stop, Close and unmount.
It runs Chromium, Firefox and Linux WebKit at 1366/390px; Linux WebKit is not Safari.
These are local paint controls, not authenticated product Try or common-cap proof.
