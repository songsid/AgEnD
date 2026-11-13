# Acting-administrator directory preparation

The accepted roles model allows a current administrator to change the directory.
That person must reauthenticate their own identity in the old trusted directory
and remain eligible in the candidate directory. The configured root must also
remain eligible there. Rewriting the actor to the root, or accepting the root's
password for an auxiliary actor, would violate both attribution and authority.

This slice prepares the private proof engine and controller. It does **not**
convert the live HTTP adapter, sealed writer or browser rotation, and does not
mint the new witness in production. Their configured-root checks remain. No
auxiliary directory save can complete through the production path yet.

An internal caller may bind an already acquired, actual session-owned
`hub.admin` permit to an opaque witness. Its private WeakMap record captures
the exact acting person/session/request, permit method and image, directory
object, configured root, source image and directory epoch. An observed failure
permanently retires that witness. A copied object or JSON value is not a witness;
split management permissions cannot create one. This binder is a trusted server
adapter, not an independent authentication source or a body-decoding API.

Directory contexts copy the actor and callback/signal and retain the opaque
witness by identity. They never serialize it. Proof preparation, controller
reads, CA inspection and Save orchestration retain it through asynchronous and
reentrant boundaries. Without a witness, the legacy path remains configured-root
or D3 host only. A host recovery identity cannot consume a browser witness.

The proof engine checks the acting administrator's old-directory authentication
and fresh old-directory eligibility when using a recent server attestation.
Personal credentials still have exactly one destination: the old trusted
directory. The candidate gets service credentials only. Candidate eligibility
checks include both the configured root and a distinct acting administrator;
both are checked again after retained group GUID reads. Physical admission uses
the acting administrator's key. Host recovery retains its root-key admission
and does not authenticate to the unavailable old directory.

The same witness is checked before/after directory work and through the engine's
writer-current callback. In this slice the new role tests use an inert writer;
this does not establish compatibility with the actual directory transaction.
That transaction rebinds the canonical policy and advances its authorization
version before its last proof callback. Later integration must recognize only
that exact operation-owned old proof basis, without allowing unrelated policy,
floor or role changes. It must also support the auxiliary browser's new-generation
handoff while proving current authority. The old root-only writer and rotation
remain unchanged until those pieces are converted together and tested on the
real route. Do not work around them with a root actor or an invented session.

The existing five-minute draft and reauthentication windows remain. The new
management witness also retains its original short authority deadline; it is
never extended to make a slow operation pass. Final integration must account
for slow reads with fresh bounded proofs rather than widening a stale witness.
Post-decision physical completion and exact compensation still belong to the
existing writer/recovery design, not to an old browser or this witness.

Tests use actual roles, sessions, audit SQL and the shared read pool, with
fictional directory results, an inert candidate and writer, and direct private
controller calls. Existing directory proof/control/CA/Save/session suites are
regression controls. There is no new mounted auxiliary route, production role
cutover, live directory, account, browser, container, backend CLI, native OS or
pilot claim. No UI, assets or configuration format changes; no PNG applies.

Before activation, this preparation can be reverted with roles still inactive.
After activation, use reviewed forward changes and retain every raised policy
and authorization floor. The parent chain, plain alpha sync, exact-head review
and CI, and release freeze remain independent gates.
