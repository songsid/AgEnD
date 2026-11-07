# Group-policy administrator control

This step of [#3298](https://github.com/songsid/AgEnD/issues/3298) supplies the server-owned read, group-selection feedback and exact-resource resume methods for the [admin DTO](../../src/hub/group-policy/admin-dto.ts). It is not mounted on an HTTP listener yet. The complete sealed impact preview, apply transaction and fleet/publication enrollment must be present before the composer attaches an admin control or advertises `group-policy-v1`. Group policy remains off by default.

## Authentication and reads

The control captures the request callbacks before its first await. It authenticates through the existing `requireAdmin` path and independently compares the returned immutable person with the configured **directory administrator**. A typed actor, another directory person or a local-host actor carrying that person's binding is insufficient. Returned actors and keys are copied. The captured session and server lifetime remain current after awaits; close permanently fences pending continuations. Only contexts captured by this control may be re-authenticated through its boundary helper.

This keeps the existing role mapping. [concepts.md](../concepts.md) defines “host owner / operator” and “fleet admin (`admin_users`)”, whose powers include “Can: admin-gated commands, confirming sensitive changes, managing access.” Those fleet roles do not substitute for the Hub's configured directory administrator. HTTP presentation must retain the Hub listener's existing configured-admin, same-origin and CSRF checks; this internal library creates no alternate route or authentication session.

A ready binding returns the current policy and current suspended resources. An old directory generation returns a read-only repair-required response with `policy:null`, without constructing the strict mismatched store. Unsupported directory profiles remain readable but cannot resolve policy groups or resume group resources. Neither read nor selection registers provenance, grants permissions, or performs a bulk directory export.

Group selection uses the existing bounded AD direct-GUID driver. It returns the server's canonical DN and immutable key, copied before the final administrator re-authentication. Failure reasons are bounded; exceptions and malformed/foreign-realm results become unknown. This response is input feedback only. Preview and apply must resolve each selected DN again and compare its selected GUID; a reused DN must never inherit policy.

## Resume only a current resource

The request carries the resource's kind, ID and business revision, plus the policy and lifecycle revisions the administrator saw. It never carries an owner. The inventory derives that owner from current persisted state:

- A fleet must still have an active credential and the same generation.
- An exposure must still be published and unfrozen at that revision, on an active credential-bearing fleet with the same owner. Its policy and fleet binding are included in the captured fingerprint.
- An asker must have its canonical immutable-person provenance, revision 1 and an ID equal to that person's object ID.

The paused list excludes withdrawn, revoked or replaced ordinary resources. Resume cannot unfreeze a publication, restore a revoked fleet credential, grant an ask permission or reopen an old consent revision. A corrupt provenance owner is refused rather than displayed as the ordinary owner's record.

The control compares the three revisions before membership I/O. Its current callback rechecks the ordinary binding throughout the existing action adapter's directory/admin awaits and same-DB lifecycle transaction. The adapter re-authenticates the configured administrator, audits the fresh group allowance, compares the captured global authorization version transactionally, and advances that version with the lifecycle write. A successful commit refreshes member sockets afterwards. Positive membership alone never resumes a suspended row. Unknown/negative facts do not broaden access, and changed policy, session, credential, generation, owner, publication state or material withhold the continuation.

## Preview and composition still required

Unknown membership will appear in the future impact preview as a separate **HELD** group, with a count and the explanation “AD did not report group membership.” It does not block an explicit settings save, authorize a new action or change an existing resource. Only an authoritative negative or explicit policy narrowing may suspend. Apply must recheck the facts and impact; a changed impact needs another preview. Administrator authentication/eligibility and selected DN-to-GUID resolution must succeed independently.

Acceptance for this slice uses scratch SQLite, the actual policy/lifecycle/authorization libraries and fake directory callbacks. It claims no mounted route, editor, real-directory/account, browser, pilot, native-host or deployment acceptance. Rollback is a code revert: this slice adds no migration or configuration and is uncomposed. Existing Hub schema/floor backup rules remain unchanged.
