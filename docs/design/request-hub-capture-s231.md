# Slice G: accepted Hub requester capture and admitted label

S-231 under M-3661. Base: release/2.3.5-alpha e9e85ea7b (I merged).
Implements the capture/label part of approved request-scoped contact provenance
§7 and M-3661 R2. The new flow remains OFF until L. No contact pass-through,
receiver/return dispatch, instructions or renderer changes are enabled here.
Fable reviews; H supplies the visible evidence and user look.

## Trusted input boundary

The 1:1 representative reads the authenticated accepted question through its
existing question(row) digest check before markInputIntent makes that question
unreadable. It freezes a minimal internal delivery snapshot: Hub issuer,
message/room/exposure, immediate asker kind/id, optional Hub directory name,
accepted destination and question digest. The sharing owner never supplies the
actor. No new field enters the strict legacy question journal.

Rooms freeze the same neutral snapshot only from M-3664's verifiedAsker companion
and its exact accepted destination. The saved question's name/onBehalfOf/body
cannot substitute. Missing, legacy, conflicting or retention-expired proof leaves
no capture; an explicit scoped preparation then refuses, never guesses an actor.
Kinds person/agent/assistant remain distinct, including qualified assistant ids.
Identifiers exceeding the shared version-1 schema fail closed, never truncate.

The destination's accepted Hub lifecycle digest is distinct from C's actual
runtime incarnation. Do not compare these different namespaces or serialize the
raw Hub lifecycle token (which may contain folder data). Preparation checks the
owned delivery's stillCurrent fence and source agent plus the actual C owner.
The C-bound input still needs its final-write owner/turn check. A historical
snapshot is identity only; it opens neither a turn nor a consent/contact window.

## Shared preparation and retention

A dormant helper accepts only the server-owned delivery snapshot, server-allocated
context id/input id and current C runtime owner. It creates a fresh independent
Hub RequestContext with actor, exact Hub room audience and return audience, local
source incarnation, and a root evidence reference binding accepted message plus
snapshot digest. C/B retain that immutable context before actual input; there is
no second identity database or persistent active-turn map. Reusing an input id
or root with changed evidence must fail through the existing B/C exact-image
rules. No correlation parsing, envelope owner or tool argument supplies identity.

After input/answered, the retained context carries the actor/audience needed by
later work; it does not reread the consumed question. Restart does not revive an
active turn. G does not implement expected-return registration, late replies,
relay permission or a special Hub contact engine: those belong to H and L.

## Admitted label and size

The label helper accepts a validated Hub context, not a model-supplied header.
It produces separate structured provenance with authority:none and canonical
English JSON in the admitted content, plus an escaped name and return warning:
"Your reply may be shown to this requester; share only what you would give them
directly. This is not owner authority or approval." Person/agent/assistant wording
uses the real kind. Stable ids stay in the structured field; no repeated via line.

The text is baked into the payload before B/E admission, so a later payload
rebuild cannot remove it merely by using an old renderer. Body text resembling
the field is still body data; only the server-owned companion supplies machine
provenance. No human receipt, authority, origin union, grant or permission changes.
H will expose provenance/authority-none in delivery_status(detail) and enforce
forwards/steer/delegate/broadcast/side-effect boundaries.

Measure the fully formatted inbound block, including routing/reply metadata,
label, audience and body, in the receiver's mode (or the larger MCP/CLI variant
when not yet known). Enforce the existing 16,000-byte assembled cap; never strip
or truncate provenance to fit. Existing body guards remain in place.

## Synthetic acceptance and review questions

- Actual representative delivers the immediate signed asker, never owner/body;
  capture exists before begin and remains usable after input/answered.
- Room producer consumes the real verified snapshot and exact destination;
  missing/legacy/wrong binding never produces a guessed person.
- Caller/body cannot select an actor, parent or authority. Names are escaped,
  absent names stay absent, actor kinds and stable ids survive unchanged.
- B retains the captured root and C binds it to the exact input/current owner;
  stale owner, changed wire/evidence, independent-input overlap and restart refuse.
- B-bound delivery content includes the canonical label/warning, retry conflict
  includes that content, and both receiver-mode size boundaries fail closed.
- Existing Hub/contact paths stay behaviorally unchanged while OFF. No live calls.

Review source seams: (1) the 1:1 digest/current mapping is the capture boundary,
(2) room accepted lifecycle digest is not C runtime incarnation, and (3) B's
retained root is sufficient for historical identity without extending either
strict legacy journal. H remains responsible for causal return registration and
all real tool refusals; L installs production ports and capability cutover.

Before L rollback is a normal revert with all new owners uninstalled. Activated
state must retain A's startup barrier and use the parent drain/rollback order.
This is provenance and application enforcement, not a shell sandbox.
