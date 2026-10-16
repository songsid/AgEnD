# Owned Canvas Worker frame transport (#1629 B2)

`src/ui/shared/effect-frame.js` is the unmounted parent transport. No product code imports it and it is not added to the UI static-file allowlist. It creates a frame only when an explicit caller invokes it; tests use inert DOM boundaries or private scratch servers/browsers. It does not enable effects in the dashboard.

## Owned handshake and lifetime

The caller supplies a host-owned connected root, a distinct normalized preview origin, the current listener's boot id, and an already validated render payload. Same-origin, mixed-content, malformed origin and unknown boot inputs refuse before a DOM effect. It snapshots code, primitive params, wants and raster bytes before waiting. Payloads are bounded; there is no HTML/DOM input, origin field from a manifest, workspace path or executable callback in render data.

The frame loads exactly `/effect`, with `sandbox="allow-scripts"`, no same-origin/forms/popups permissions, negative tabindex, hidden accessibility semantics and no referrer. A fixed class is its only styling interface. This module creates no inline style, CSS text or authored layout. The actual trusted document and Worker CSP remain the existing `web-effect-worker.ts`/`web-preview.ts` implementation.

The initial hello requires the exact owned WindowProxy, opaque `event.origin === "null"`, current boot and closed `{v:1,type:"ready",ch:null,boot}` shape with no transferred ports. The host claims this handshake once before creating/transferring its private channel. `targetOrigin:"*"` is required for the opaque destination; it does not replace the WindowProxy/boot checks. Code runs only in the existing dedicated Worker; the document remains trusted shim plus canvas.

On that private port the parent accepts exactly one exact `{type:"ready"}`. All other inbound messages, including timing, pong, focus and forged/duplicate readiness, have no callback, counter, timer or state effects. No child-cost channel is added. Outbound signals require actual readiness and the independent `maySendEffectEvent` own-instance/wants fence; parent identity never comes from event data.

Construction arms a ten-second monotonic startup budget. The clock and deadline are rechecked at valid hello and valid ready acceptance, so a delayed timer cannot allow an overdue handshake. An early timer rearms only the remaining budget. Clock failure/rollback removes. A second load removes the frame without distinguishing benign reload from navigation. A disconnected/reparented frame is revoked before another send. Removal is one-shot: detach listeners, clear the timer, close both private endpoints, remove the iframe and invoke the host callback once. A host ready callback that throws also removes. A boolean send result means the host accepted a port write, not proof of Worker consumption.

## Required gates before product mounting

This transport is not a registry or an admission decision. The later integration must reserve the shared 3/1 pool and 2/1 front subcap before calling it, enforce all preview/opt-in/public-link/safe/visibility gates, bind the current launch/resource/params, provide trusted geometry via CSSOM and fixed pointer-events/opacity classes, and implement fail-closed trust clipping/observers. It must also prove a visible two-second pre-effect host cadence measurement with no frames before initial mount and human Resume, then connect the reviewed profiler and physically remove frames on pause/off/hidden deadlines. No fallback mounts are permitted while any prerequisite is unknown.

The factory itself must never be treated as permission to bypass those gates. It is intentionally not wired into Fleet pages, Settings, public-link routes or a tool by this PR.

## Verification and rollback

The unit tests execute this actual module with inert host window, DOM, ports and deterministic timers. Native scratch controls use the actual built preview listener and this source module in Chromium, Firefox and Linux WebKit; final receipts must distinguish passing cases from excluded harness trials. A form submission may be blocked by sandbox/form-action before a navigation occurs; it is not counted as a second-load witness. Actual valid-document location/meta navigation and normal one-load/physical-removal controls are separate.

These are no real-Safari, physical-IME, full dashboard, registry/cap, trusted-geometry or profiling-integration claims. No live fleet, account, service, default tmux or tunnel is used. Rollback is reverting the unmounted helper, tests/recipe, this note and paired fragments. No persistent state, migration, config or startup work changes.

The render asset list contains only `assets/<safe-name>.<raster extension>`. `poster.png` and `cursor.png` are host-only assets; passing either to this factory refuses the render before any iframe is created.
