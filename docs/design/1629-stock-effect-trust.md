# Stock shell paint prerequisite (#1629 B2)

This foundation annotates the **real** stock component producers, defines paint
bands in the real app stylesheet, and supplies an unmounted closed inventory/paint
snapshot. It does not import that snapshot into the app, serve it as a public asset,
create effect frames/Workers, or enable playback. A later reviewed adapter must
consume it before any effect is admitted or revealed.

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

Inventory/paint work is bounded (128 marked roots,4096 descendant observations).
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
reason and `/ui/settings/appearance`, for the subsequent runtime status UI to show:

- EN: **Agent foreground effects are paused while your custom CSS is on or unavailable.**
- zh-TW: **自訂 CSS 已開啟或狀態不明，agent 的前景效果暫停。**
- Action: **Open Appearance settings** / **開啟外觀設定**.

Behind effects still require proven ordering. Human placements do not bypass
geometry, global modal, frame caps, safe mode, consent or performance gates. The
future adapter must derive CSS state from the host's actual owner-CSS lifecycle;
an author or manifest cannot supply it. Unknown route geometry is refused; this
initial snapshot supports the real open-instance Chat route, not other panels.
A trusted foreground/paint-containment plane is deferred in #1940.

## Required adapter protocol (not wired here)

Hide owned fronts synchronously on invalidation, before recomputing geometry;
re-observe this snapshot in the same host rAF before reveal. Feed its paint bounds
into the geometry clipping seam, rather than going back to raw border boxes. The
existing registry invalidation already hides geometry, but this foundation does
not claim a connected runtime adapter or automatic overlay enforcement.

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
