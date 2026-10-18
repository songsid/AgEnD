# Stock shell paint prerequisite (#1629 B2)

This foundation annotates the **real** stock component producers, defines paint
bands in the real app stylesheet, and supplies the closed inventory/paint snapshot consumed by the reviewed Chat
adapter. The full-app extension below broadens the proof primitive, without
starting any personal or non-Chat playback. Admission still requires the
separately reviewed identity, consent, registry and resource gates.

## Ordering

Structural ancestors `html > body > #app > .shell > .main > .p-chat >
.chat-split > .chat-main` remain neutral: no independent z-index, fixed/sticky
position, transform, opacity, filter, mask, isolation, containment or unknown
coordinate conversion. Raising the entire app would trap all its children behind
a sibling front plane and obscure behind effects. The previous registry recipe's
substitute `#ui` at z=1 did not prove this real shell.

The body-sibling effect root uses behind=0 and front=20. Bounded stock content owns
level1: the thread scroller, composer dock, cards/widgets, sidebar children, usage
children and desktop preview. The header owns level2, so its nested menu remains
above the later scroller's level1 stacking context. Native/top-layer and existing
mobile overlays retain their existing levels. Menus nested in content cannot
out-rank front20; a front must be hidden while an overlay is active.
The existing narrow chat-header widget fade is the sole content-mask exception:
its exact black-to-transparent 32px gradient only removes paint within that
already bounded level1 context. Unknown masks, other surfaces and ancestor masks
remain refused. All three tested engines accept this stock computed form.

The first native menu hit-test caught and corrected a draft equal-level header
regression before review. The recipe now checks both control paint and actual menu
hit testing. The actual `#app` remains auto; the negative control that raises it
must refuse, rather than reproducing the old synthetic fixture's ordering.

## Closed trust roots

`STOCK_TRUST_INVENTORY` pairs each fixed category with known stock selectors. It
finds expected producers **without requiring a marker**, then checks their exact
marker. An unexpected marker or a missing/wrong marker is unknown coverage.

- Composer dock and permission prompts; generated reply/poll groups and voter rows.
- Header, navigation/sidebar and its resize separator, identity card (including its toggle),
  jump-to-latest, status/operation line, usage, host-rendered widgets,
  Needs-you permissions and pending settings confirmations.
- Shared menus/dialogs, session/preferences popovers, preview menu/panel/divider,
  command palette, drop overlay, Keep bar and toasts.
- Direct-body tour and session-ended banner; the latter retains its existing
  emergency inline presentation and also refuses all admission.
- Message/status Copy/fold controls, code controls, attachment text controls, HTML
  preview controls/safety notices, renderer-created links, attachment groups and
  native media wrappers. Markdown escapes input before fixed markup, so authored
  text cannot inject these attributes.

Inventory/paint work is bounded (4096 marked roots,4096 descendant observations; at most 128 paint rectangles).
Unknown/malformed or excessive coverage refuses. Geometry is copied into plain
numeric rectangles. Protected rectangles conservatively union descendant bounds,
stock outer shadow outsets and focus outlines; unknown shadows/text shadows/filter
paint refuse. No message text, labels, URLs or other content is read or returned.

## Suppression and custom CSS

Visible menus/dialogs/listboxes/open details, Keep, tour, toasts, floating pending
cards, drawer/drop state, narrow preview sheet, native media/fullscreen and focused
editable/select inputs suppress **all** fronts. OS/native popup paint has no
reliable DOM rectangle, so the policy is conservative. A hidden content wrapper
with visible descendants cannot silently lose its level1 band.

Only a positively known `ownerCss: "off"` allows an **agent** front. Active,
loading or unknown custom CSS leaves that placement paused; human front placements
keep their exemption from this agent restriction. The snapshot returns a closed
reason and `/settings/appearance`, for the subsequent runtime status UI to show:

- EN: **Agent foreground effects are paused while your custom CSS is on or unavailable.**
- zh-TW: **自訂 CSS 已開啟或狀態不明，agent 的前景效果暫停。**
- Action: **Open Appearance settings** / **開啟外觀設定**.

Behind effects still require proven ordering. Human placements do not bypass
geometry, global modal, frame caps, safe mode, consent or performance gates. The
future adapter must derive CSS state from the host's actual owner-CSS lifecycle;
an author or manifest cannot supply it. Unknown route geometry is refused. Chat retains its granular proof; the full-app
extension below adds a closed proof for the other stock producers.
A trusted foreground/paint-containment plane is deferred in #1940.

## Required adapter protocol

Hide owned fronts synchronously on invalidation, before recomputing geometry;
re-observe this snapshot in the same host rAF before reveal. Feed its paint bounds
into the geometry clipping seam, rather than going back to raw border boxes. The
existing registry invalidation already hides geometry, and the reviewed Chat adapter follows that protocol. Broadening the snapshot
does not itself create a non-Chat runtime owner.

## Evidence and limits

The checked-in scratch recipe renders actual Shell and ChatPanel with inert API
fixtures, actual renderer reply/permission controls and real styles. Host-owned
canvas probes use the existing geometry helper with this snapshot's host-derived
paint rectangles. They are diagnostic probes, not a product frame registry or mod
code. It compares behind/front protected pixels, verifies uncovered paint and
click-through, exercises real menu/dialog/Keep/tour/focus/drawer producers, and
refuses missing markers, root stacking, negative content, isolation and transforms.
Real opened desktop preview panel/divider ordering is checked too; negative z,
transform and opacity refuse, while the narrow sheet suppresses fronts. Real
identity toggles, a scrolled-up jump control and the sidebar separator have front
paint samples plus missing/wrong-marker controls. Actual truncated HTML and
wide-CSV fallback notes retain their fixed markers and paint samples.
A real theme image and host widget exercise the alternate stock layout. Front
clipping also preserves a translucent permission-card background sample. Behind
effects may tint translucent stock backgrounds, as expected from a layer below
them; opaque controls retain their pixels. This is not blanket pixel invariance
for every background.

The browser container has no network, no real account/fleet/tmux/service, and no
/tmp bind. Chromium/Firefox/Linux WebKit are distinct engine checks; Linux WebKit
is not physical Safari, OS picker, font/IME or an exhaustive visual proof. No new
HTML effect model is introduced. Dedicated Worker/shim/ready-only/CSP tests remain
separate prerequisites, as do final product mount and durable safety integration.

Rollback: revert annotations, stock bands and this unimported helper together;
there is no data migration or active effect to stop. Existing custom CSS may rely
on prior stacking; agent fronts are blocked whenever it is on/loading/unknown.
Any unknown template/layout remains unavailable rather than losing coverage.

## Closed full-app extension

The six non-Chat producers (Fleet, Needs, Settings, View, Log and Details) now stamp a fixed `data-effect-panel`. Exactly one `.main > .panel` must have its expected class and direct-child topology. A missing producer, extra class, unexpected direct element/text, duplicate parent or generic Outlet loading/error panel refuses. Known producer loading/not-found states retain their bounded stock body. View accepts either its loading/error/empty body or its ready terminal/card with an optional expanded identity block; mixtures refuse.

New independent expected selectors require `panel-navigation`, `panel-content` and `panel-controls` markers even when the marker is missing. They protect Fleet/Settings segments, all six bounded panel bodies, Log filters, View terminal/profile/identity and the sticky Settings Apply bar. The real stylesheet puts these bounded surfaces at level1, keeps headers at level2 and leaves panel/app structural ancestors neutral. Only the known Apply bar may stay sticky. Inline Settings confirmations are also in the closed inventory. Menus/dialogs still suppress all fronts; owner CSS still denies agent fronts independently of route proof.

Protection conservatively unions all descendants of each bounded parent, so agent fronts may have very little visible area on these pages. The 4096-root/4096-observation limits are enforced; a large log/settings/organization view may refuse playback rather than silently skip protected nodes. Structural proof is not authorization: it does not grant anonymous View, public-link or header-token users a personal identity, and does not alter Settings' owner-CSS recovery exclusion.

`scripts/manual/effect-stock-routes-1629.mts` renders the real Shell and all six real producers with inert local HTTP fixtures. Chromium/Firefox/Linux WebKit at 1366/390 verify every Fleet tab and Settings section, View expanded/loading/error/empty/not-found states, Log filters/loading/not-found, Needs permissions, Details ready/loading/not-found, a real locally staged sticky Apply bar and inline confirmation. Protected controls have front paint samples; missing markers, negative bands, transforms, unknown children and the real generic Outlet fallback refuse. No author effect, iframe or Worker runs. Fixture failures from an incomplete Appearance API response and unsettled stock hover transitions are retained separately; the recipe supplies the real response shape and lets transitions settle, without changing production checks.

Rollback this extension's producer markers, CSS bands and proof together. Before reverting it after a future personal mount, disable that mount first. No stored format, authorization, network policy, effect bundle or frame cap changes here.


## Long conversations (#2147)

A native 65-message Classic chat with persona palette/font, looping ambient and a placed CW produced 207 protected
markers. The old 128-marker check rejected the whole stock proof; registry fallback used boolean false as a reason,
rendered as `unknown`. Try consulted the same refused proof, invalidated its stage and closed without retaining why.
This reproduces both symptoms on Linux Chromium. The reporter then measured **136** protected markers on their failing
Windows Chrome localhost chat, confirming the same old 128-marker cutoff. A short mixed conversation passed.

All markers still belong to the closed inventory, including off-screen history. Marker scans and ResizeObserver setup
are capped at 4096; descendant paint work retains its 4096-observation bound. Paint bounds fully outside the viewport
plus the clip's 8px margin are omitted only after their producers and paint were proved, either by the bounded descendant walk or the contained-box proof below. If more than 128 bounds
remain, the tail is conservatively unioned into the final rectangle. This can clip extra effect pixels, never expose a
protected pixel. Missing markers, unknown paint, changed stacking, overflow and unsupported proof remain refusals.

Refused stock data has a separate descriptor-only local diagnostic path, never paint authority. Registry rows and local
console warnings retain a bounded code; Try passes its stage termination reason through source/controller to the offer
card. The closed agent telemetry vocabulary remains unchanged. A real window blur still stops Try; pointer leave does
not. No timing delay, permissive proof fallback, Worker channel or authorization change is introduced.


### R2: paint work at the actual history cap

The browser retains at most 500 messages (`chat-store.js`), draws them in 40-message chunks, and initially requests
200 history rows. A real Classic fixture with one link and one code block per message used about ten descendant visits
per message: 955 at65, 2302 at200, 3306 at300, 4306 at400 and5296 at500. The old 4096-work limit is therefore reachable
around379 messages; merely raising the root cap was insufficient.

Only the stock `.msg-tools` and `.codeblock > .cb-head` toolbars now have physical paint containment and clip overflow.
The former has four pixels of padding for the existing focus ring, with compensating margins. These are button bars,
not preview menus or inline links. A fresh proof may use the entire toolbar box instead of walking its descendants
only with exact flex/principal-box, single-fragment, `contain:paint`, both-axis clip, zero clip margin, no filter,
no border image and visible content evidence. For engines without overflow-clip-margin (the checked Linux WebKit), an absent computed value is accepted only with an explicit CSS.supports=false result; supported-but-unreadable, unknown and expanded margins take the bounded walk. Own outline/shadow outsets refuse this shortcut: containment clips
children, not the root's own ink. Other roots retain the bounded walk. Missing markers are still checked globally.

[CSS Containment Level2 §3.4](https://www.w3.org/TR/css-contain-2/#paint-containment) specifies descendant clipping and
establishes a fixed-position containing block; inline/contents boxes do not establish this proof. The native maximum
history case injects fixed children into both an off-screen and a visible contained toolbar, checks actual fixed positioning and independent
inside/outside clip pixels (fully outside pixel cells, excluding fractional boundary cells), and still requires ordinary
CW pixels, protected controls, stage-only Try pixels and exact Stop removal.
This proves the actual 500-row workload rather than extrapolating from the 65-row reproduction. Uncontained or
pathological work still fails closed with its local named limit; no paint-work or frame cap is raised.
