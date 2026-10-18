# Canvas Worker playback from defaults (proposal)

Status: design and proposed Try boundary approved by the leader (xmsg-1792311903419-5hcdhe); follow-up #2118. Deliver in three reviewed PRs; does not hold beta.7. This note does not change admission.

## Experience

A placed chat effect starts when the viewer shows agent appearance. Safe mode refuses it; hiding the tab pauses it; the live performance guard can pause/off a lagging effect with a persistent reason. Existing per-person locks/reset, caps, protected pixels and cleanup remain. Data saver becomes informational rather than an independent hard gate, matching the requested closed list.

Reduced motion becomes a **device-local** preference: “Effects: follow the system’s reduced-motion setting”, initially off, shared by CW and host-drawn ambient playback. No host-wide or cross-account preference migration. When the system requests reduced motion and this option is off, show a one-time-per-device chat note with an action to the exact switch. Turning the option on pauses affected playback and names the reason. Storage failure keeps the choice for the page; it never silently turns the option on.

## Isolation and transport

First prove an opaque-origin, `sandbox="allow-scripts"` frame in Chromium, Firefox and WebKit. Prefer host-generated `srcdoc` with a fixed, trusted bootstrap and a narrower CSP, creating a Blob classic Worker. No `allow-same-origin`, forms, navigation/popups or user HTML. The bootstrap receives only host-validated code/params/raster bytes and its transferred canvas/port. The agent's code runs only in the Worker.

Threat model: agent code must not reach page/frame DOM, cookies/storage, AgEnD APIs or the network, including fetch, WebSocket, importScripts, nested workers and URL-bearing canvas/image paths. Frame CSP and inherited Blob-Worker CSP must deny network; test actual requests, not only policy strings. Parent/child CSP intersection is a design constraint: a srcdoc meta policy cannot loosen the parent's worker/script policy. Any required parent CSP change must remain limited to trusted bootstrap capabilities and be separately reviewed. If this cannot be proved on all engines, stop and report the concrete incompatibility; do not fall back to a same-origin frame.

Bind the one-time MessageChannel handoff to the exact iframe `contentWindow`, the current generation and a random host token. Opaque `event.origin === "null"` is never identity. Retain the closed message codecs, ready-only inbound, caps, cancellation settlement, epoch/current fences, protected paint inventory and host-owned controls. The Worker never supplies authority or a destination URL.

Placed-resource reads become available on the authenticated public-link surface only for an exact current visible instance placement, never a general library/private owner-slot grant. Recheck placement/reference on every code/asset read; no principal/holder export. Public-link continuity and exposure revocation still apply. Public viewing does not grant placement, sharing or trial authority.

## Start and live guard

Remove the two-second calibration **admission** gate. Start drawing immediately. Keep warm-up and consecutive bad-window/long-task guard, sticky three-pause safety and person-only Resume. Learn an appropriate display cadence concurrently from host rAF timestamps; a low-refresh or power-saving display alone must not trigger a pause. The implementation must pin 30/50/60/144 Hz, long tasks, clock errors, hidden/resume and true induced jank. No fabricated baseline or unconditional 60-Hz assumption.

## Try

Keep Try as a volatile preview before a person saves a placement: one click, host label and Stop, clipped stage, stop on close/navigation/another dialog/true window blur. No preview port, HTML consent or owner-CSS gate; the existing isolated host chrome remains. Proposed authorization: an authenticated admin session on any supported origin can start; public read-only viewers can see ordinary placed effects but cannot create a trial. Every read still checks the issuing agent's current own/shared rights and the bound session/epoch. No persistence/export/share/placement side effect. This authorization expansion requires explicit design approval before implementation.

## Delivery and proof

Land #2115 diagnostics first. Then review transport/CSP/public-read proof before changing product mount; follow with live guard and device preference/ambient integration. Fresh browser profiles with no seeded preferences or consents, driven through visible UI: localhost, non-localhost and listener-owned public-link fixture; system reduced motion on/off; desktop/phone; Chromium/Firefox/Linux WebKit. Screenshot playing and each remaining blocked state; verify working corrective links, actual network denial and protected pixels. Linux WebKit is not real Safari; actual Safari/Windows/phone acceptance remains explicitly separate.

Rollback: normal reviewed reverts of the affected PRs; no destructive data migration. Old diagnostic records are volatile and never admission authority.
