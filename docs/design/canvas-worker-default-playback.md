# Canvas Worker playback from defaults (proposal)

Status: design and proposed Try boundary approved by the leader (xmsg-1792311903419-5hcdhe); follow-up #2118. Deliver in three reviewed PRs; does not hold beta.7. This note does not change admission.

## Experience

A placed chat effect starts when the viewer shows agent appearance. Safe mode refuses it; hiding the tab pauses it; the live performance guard can pause/off a lagging effect with a persistent reason. Existing per-person locks/reset, caps, protected pixels and cleanup remain. Data saver becomes informational rather than an independent hard gate, matching the requested closed list.

Reduced motion becomes a **device-local** preference: “Effects: follow the system’s reduced-motion setting”, initially off, shared by CW and host-drawn ambient playback. No host-wide or cross-account preference migration. When the system requests reduced motion and this option is off, show a one-time-per-device chat note with an action to the exact switch. Turning the option on pauses affected playback and names the reason. Storage failure keeps the choice for the page; it never silently turns the option on.

## Isolation and transport

First prove an opaque-origin, `sandbox="allow-scripts"` frame in Chromium, Firefox and WebKit. Use a fixed HTTP bootstrap on the dashboard listener with its own narrow response CSP, creating a Blob classic Worker. `srcdoc` inherits the parent CSP and cannot enable a Worker when the parent denies it; widening that parent policy is unnecessary. No `allow-same-origin`, forms, navigation/popups or user HTML. The bootstrap receives only host-validated code/params/raster bytes and its transferred canvas/port. The agent's code runs only in the Worker.

Threat model: agent code must not reach page/frame DOM, page cookies/storage, AgEnD APIs or the network, including fetch, WebSocket, importScripts, nested workers and URL-bearing canvas/image paths. Frame CSP and inherited Blob-Worker CSP must deny network; test actual requests, not only policy strings. Parent/child CSP intersection is a design constraint: a srcdoc meta policy cannot loosen the parent's worker/script policy. Any required parent CSP change must remain limited to trusted bootstrap capabilities and be separately reviewed. If this cannot be proved on all engines, stop and report the concrete incompatibility; do not fall back to a same-origin frame.

Bind the one-time MessageChannel handoff to the exact iframe `contentWindow`, the current generation and a random host token. Opaque `event.origin === "null"` is never identity. Retain the closed message codecs, ready-only inbound, caps, cancellation settlement, epoch/current fences, protected paint inventory and host-owned controls. The Worker never supplies authority or a destination URL.

Placed-resource reads become available on the authenticated public-link surface only for an exact current visible instance placement, never a general library/private owner-slot grant. Recheck placement/reference on every code/asset read; no principal/holder export. Public-link continuity and exposure revocation still apply. Public viewing does not grant placement, sharing or trial authority.

## Transport foundation (PR 1 of 3)

`GET /effect-bootstrap` returns only trusted generated code, never uploaded source, account data or resources. Its independent fleet-lifetime boot does not depend on the HTML preview listener. It is deliberately credential-independent: cookies may accompany navigation but are not inspected or touched, and there is no Set-Cookie. Only the exact GET is public; current placement, private library, owner-slot, profile and Trial authorization remain unchanged.

Both the iframe attribute and response CSP use `sandbox="allow-scripts"`, with no `allow-same-origin`. The document and its Blob Worker have opaque origins even though the document URL is on the dashboard listener. The bootstrap checks its actual URL origin against the parent message, with response `frame-ancestors 'self'`; it does not select an authority from Origin or forwarded headers. Exact WindowProxy, boot and private-port ownership remain required. The boot is coherence evidence, not a credential.

The response hashes its trusted inline script and style and allows Blob Worker scripts only inside this document. Network, forms, nested frames and object/embed are closed. No parent script/style/Worker CSP widening is needed. The transport proof tests actual cookie/storage/API/network denial plus independent visible pixels; an unstarted Worker or a blocked positive-control server cannot count as isolation.

The first PR serves the fixed bootstrap and exports an unused frame helper. Linux WebKit exposes CacheStorage inside opaque Workers. The transport probe therefore checks the actual boundary: a populated parent cache is unreadable, child writes are invisible to the parent, and a second opaque Worker cannot read the first one’s entry. It does not claim that every storage API is absent.

Product mounting, shell bootstrap metadata and frame permission, public placed-resource reads, consent removal and Try cutover remain in PR 2. Live-guard startup and shared reduced-motion preference remain in PR 3. Existing skill instructions stay accurate until those cutovers; both web skills and paired user docs change alongside each user-visible policy change.

## Product transport cutover (PR 2 of 3)

The product now frames only the fixed `/effect-bootstrap` on its own accepted dashboard origin. Shell metadata has a distinct effect boot and session epoch; it does not borrow the HTML-preview boot, listener, opt-in or device “never” flag. The parent permits only that exact bootstrap path in addition to any existing HTML-preview frame path. Parent script/style/Worker permissions are unchanged. The public shell has no owner CSS, so its owner-CSS evidence is known off rather than an artificial unknown restriction.

A separate Chat-only playback identity admits signed-in public-link and scoped guest viewers without granting personal preferences, owner slots, management, profiling, images or Trial authority. Only exact GET placements/resource requests with one current instance and one matching session epoch are exposed; every resource read rechecks the current retained Chat placement, with no library fallback. Guest scope and public exposure are checked again. Guest status includes a content hash of each in-scope Chat’s placements, not the global theme revision; the bridge re-reads when the current Chat’s hash changes. Unchanged hashes preserve the frame. Guests never install owner CSS: the bridge positively checks its absence and refuses unexpected styles rather than treating the uninstalled lifecycle’s initial unknown as a permanent blocker. Removal, session expiry and exposure revocation deny the next read. Public polling does not synthesize reply pulses. Public telemetry remains closed. Anonymous View/header-only loads acquire no playback session.

Ordinary drawing no longer stops merely because the stock composer is focused. Its protected rectangle stays excluded from foreground paint; editable, design-mode and unknown focus still refuse pointer signals. Menus, dialogs, unknown stock structure and the agent-front owner-CSS restriction remain. Public/guest viewers always have a Chat-header browser-local show/off switch while placements exist, with inline recovery and no host preference write. The existing public local-storage key is shared by read-only viewer surfaces for compatibility; ordinary dashboard pages ignore it. Static posters remain the fallback for anonymous or unsupported/reduced-motion/data-saving surfaces rather than appearing beside a capable live effect.

Try uses the same isolated transport after an explicit admin click on a non-public dashboard; a LAN hostname does not require localhost, the HTML-preview port or an extra consent. It retains session/epoch/current agent rights, TTL, protected shadow chrome, clipped stage, shared caps/safety and Stop/close/navigation/blur cleanup. Public viewers cannot create trials.

The fresh-profile matrix exposed a Firefox Trial presentation failure: a one-draw Worker was ready and visible, but the bounded screenshot wait stayed blank; a later diagnostic screenshot showed the clipped paint. The Trial stage had still hidden/revealed its iframe every rAF. Like ordinary geometry, it now rechecks the complete current stage proof and actual frame bounds every tick, and reuses an unchanged verified visible presentation without CSS writes. Changed bounds or explicit hiding still require hidden verification before reveal; lost proof or hiding removes the frame. The original failed receipt remains evidence rather than a successful case.

This is intentionally an intermediate state: system reduced motion, data saver and the two-second startup baseline still refuse playback until PR 3 changes them. The PR 2 default-profile recipe therefore proves actual paint without HTML consent/listener on normal devices and asserts the named reduced-motion refusal separately. It uses visible sign-in with synthetic one-time codes, fresh prefs/consents, localhost/LAN and the real PublicWebLink/gateway fixture (external provider/tunnel/HTTPS transport stubbed), at desktop/phone widths in three Linux engines. It does not stand in for real Safari, Windows or physical-phone acceptance.

## Start and live guard

Remove the two-second calibration **admission** gate. Start drawing immediately. Keep warm-up and consecutive bad-window/long-task guard, sticky three-pause safety and person-only Resume. Learn an appropriate display cadence concurrently from host rAF timestamps; a low-refresh or power-saving display alone must not trigger a pause. The implementation must pin 30/50/60/144 Hz, long tasks, clock errors, hidden/resume and true induced jank. No fabricated baseline or unconditional 60-Hz assumption.

## Try

Keep Try as a volatile preview before a person saves a placement: one click, host label and Stop, clipped stage, stop on close/navigation/another dialog/true window blur. No preview port, HTML consent or owner-CSS gate; the existing isolated host chrome remains. Proposed authorization: an authenticated admin session on any supported non-public dashboard origin can start; public read-only viewers can see ordinary placed effects but cannot create a trial. Every read still checks the issuing agent's current own/shared rights and the bound session/epoch. No persistence/export/share/placement side effect. This authorization expansion requires explicit design approval before implementation.

## Delivery and proof

Land #2115 diagnostics first. Then review transport/CSP/public-read proof before changing product mount; follow with live guard and device preference/ambient integration. Fresh browser profiles with no seeded preferences or consents, driven through visible UI: localhost, non-localhost and listener-owned public-link fixture; system reduced motion on/off; desktop/phone; Chromium/Firefox/Linux WebKit. Screenshot playing and each remaining blocked state; verify working corrective links, actual network denial and protected pixels. Linux WebKit is not real Safari; actual Safari/Windows/phone acceptance remains explicitly separate.

Rollback: normal reviewed reverts of the affected PRs; no destructive data migration. Old diagnostic records are volatile and never admission authority.

## Immediate startup and live reference (PR 3 of 3)

The registry admits an authorized frame without calling `captureEffectBaseline` or waiting for an empty pool. The live guard observes host rAF intervals while drawing and during its existing warm-up. Before its first measured report it fixes one FPS floor for the mount: 90% of a faster observed cadence (the 20th percentile of bounded intervals; median for fewer than eight), capped at the existing device budget. Reports keep that exact floor, including across a short hidden interval. A new mount/device epoch learns afresh. No Worker timing or author-provided baseline is involved. Missing cadence does not invent a healthy window or an FPS floor; three unobserved windows pause the mount. Clock rollback still revokes immediately.

This is a live reference, not the former empty-page health measurement. It catches intermittent frame loss from startup, later sustained loss, and host long tasks where that API exists. A uniformly slow initial host can be indistinguishable from a low-refresh display; it is not proof of zero Worker CPU or attribution. Profile data continues to say unknown where observations are unavailable. The unchanged caps, off switch and sticky three-pause history remain independent protections.

`reducedMotion` in policy means the shared device preference **and** the OS answer, not the raw OS answer. Its default is off, and a failed storage write retains the explicit choice on this page. Save-Data remains observational information, with no admission or startup gate. CW and ambient share the existing one-time motion note and key; it appears only when one is running. Public/guest motion refusal offers a local recovery action without host preference writes. Safe-mode refusal offers an action that removes only the current URL's `safe` parameter.
