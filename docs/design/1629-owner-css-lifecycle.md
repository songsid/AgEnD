# Owner-CSS lifecycle evidence before effect mounting (#1629 B2)

This seam does not mount effects. It gives the future adapter positive CSS lifecycle
evidence for the approved rule: agent foreground effects are unavailable when owner
CSS is on, loading or unknown. Human placements keep their exemption from that
agent rule, and still obey stock geometry, modal and global safety gates.

## Host evidence

`WebPrefsStore.ownerCssSelection(person)` distinguishes readable absence from an
unreadable or invalid CSS pointer. Invalid CSS values remain filtered by the legacy
reader, but withhold only that bucket's CSS evidence; other preferences continue to
use their existing behavior. An ordinary successful full rewrite already discards
filtered invalid values. Its new evidence is published only after the durable write;
a failure keeps the previous unknown evidence and bytes. There is no migration.

`OwnerCssStore.effectState(person)` returns `off`, `on` or `unknown`. It requires a
readable, valid pointer and CSS index (ENOENT is an empty index; other errors are
unknown). A selected version must have retained, valid CSS. Providers without the
new optional evidence accessor return unknown, never off. Legacy nullable accessors,
save/serve/trial formats and per-person identity rules are preserved.

The existing signed-in `/ui/owner-css/state` response includes `effectState`. Full
local shells carry `data-owner-css-state`; no-person/header-token/View/public shells
carry unknown. The active sha still appears only where its person may use it. No
new route, authorization grant, polling or account fallback is added. Existing CSS
state reads remain authorized by the existing session gate.

## Page lifecycle

`ownerCssLifecycle` is a read-only store of frozen `{state,generation,reason}`
snapshots, initially unknown. Consumers may subscribe but cannot substitute a
manifest or nullable active version as evidence. Every publication advances its
page generation. It carries no CSS text or platform identity.

- Publish unknown **before** changing a link, changing route eligibility or beginning
  a host state refresh, so a synchronous consumer can hide its agent fronts first.
- A new version gets a new owned link, last in head. Late load/error events from a
  removed/replaced version cannot modify the current generation. A foreign element
  with that id is unknown.
- Loading stays loading until the current connected owned element reports `load`
  with the exact same-origin stylesheet href, owner node and enabled flags. Then it
  is on. An error or unverified sheet is unknown. On proves an observed stylesheet
  load, not successful image/font subresources or that every rule took effect.
- Off requires physical removal (including no duplicate id) plus positive host-off
  evidence or an actual host-disabled context: Settings, safe mode, ineligible page
  or the verified per-device off switch. A failed/no-op storage write is no proof.
- Refresh failures/malformed/legacy replies withhold off evidence. The old CSS may
  remain physically linked as before; unknown denies agent fronts just as on does.
  Existing local-change/read generation fencing prevents stale host replies from
  overriding newer accepted local changes. Optimistic trial rollback to null stays
  unknown until confirmed by the host.

The link remains a fixed same-origin link under `style-src 'self'`: no inline style
text, constructed stylesheet, new nonce or untrusted script. This is a pre-mount
signal seam; the stock predicate, registry per-placement guards and status UI must
consume it in a later reviewed adapter. The known Chat stock surface is not a claim
that every other dashboard panel is ready for effects.

## Verification and rollback

Unit controls cover valid/unknown storage, independent identities, successful and
failed durability, matching native load fields, load errors, old events, duplicate
or foreign links, physical removal, failed device-switch writes, state/read fences
and Settings/safe/public modes. Existing CSS gate/store/routes/client/prefs tests
remain applicable. The native recipe tests real stylesheets and colors on Chromium,
Firefox and Linux WebKit at desktop/phone widths in a network-isolated private
container. It is not a real Safari/account/fleet test and never mounts an effect.

Rollback this lifecycle metadata/module change together; no durable format changes.
The future effect adapter must continue treating missing evidence as unknown when
this seam is absent. Retained CSS and preferences need no conversion. Replacing a
stylesheet link on version change may briefly show stock styles while the new sheet
loads; CSS/trial selection itself is unchanged.
