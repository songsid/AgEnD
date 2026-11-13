# #3878: retained representative question blocks member startup

The alpha.4 rehearsal's F1 fails before opening a link. `HubMemberJournal.bindPairing` (introduced with the journal v2 adoption path) compares `hub_representative_questions.digest` with the question's **content digest**. The actual representative outbox stores **questionContextDigest(question)**, covering the immutable question identity and content. These digests differ for an ordinary valid question. The representative's own lookup and dispatch already use the context digest. The old adoption test manually inserted a content digest, hiding the mismatch.

The fix compares the representative row with the authenticated journal row's `contextDigest`, matching the existing execution-queue check. Source, exposure, revision, issuer, pairing, AEAD and version-floor checks remain in place. No migration or data reset is required.

## Finding-time rig evidence

`rig-diagnosis.json` describes a read-only inspection of the finding-time F1 backup supplied by the sealed rehearsal rig owner. The single message is journal-queued without input intent and representative-held. Its binding is absent, its journal floor agrees, and its payload authenticates. The representative digest equals the authenticated context digest and differs from the content digest. Source and exposure/revision match. A disposable copy adopts with the fix while both message and representative rows remain byte-identical. The original DB, profile, encryption material and question text are private and are not committed.

The stopped original container is retained. Its web certificate and Hub package were changed after the finding; the finding-time backup predates those changes, so this diagnosis does not rely on the later Hub state.

## Validation

- `fail-first.log`: the new regression uses the **actual representative outbox writer** and SQLite. Before the fix it fails at `bindPairing` with `Hub protocol: uncertain`.
- `focused.log`: journal, representative, recovery-state isolation, member reconnect and member composition: **90/90 across five suites**.
- `factory.log`: **1/1** using the real member factory, on-disk v1-format state and pinned TLS/WSS. It creates a real question held before input, closes the member, restores only the pre-binding schema shape, and starts the upgraded member. It reaches online, preserves the old hold without a new hand-off, answers subsequent work once, and deduplicates a replay. Hub policy/receipt replies and physical agent input are inert.
- The representative regression separately proves a queued legacy question completes once when its link returns; the held control proves a failed-before-input hand-off stays held. A negative journal control refuses a representative row carrying only the content digest.
- Native source and test programs both complete with no diagnostics. `verification.json` binds the checked source and test files.

A test-only follow-up captures one clock sample for issuedAt/expiresAt, avoiding a 120-second boundary flake. The factory case and native test program were rerun successfully; product source and the earlier five-suite/source-type results are unchanged.

The two early factory-harness failures (an undefined mock authorization version, then counting progress receipts as replay ACKs) were corrected before its passing run; neither is claimed as a product regression. There was no new broad security or mutation campaign, live AD/account/API call, or real agent input.

## Risk and rollback

The change affects adoption of legacy representative state only. It neither resumes a held question nor relaxes acceptance of a wrong context digest. To roll back, revert the fix commit; do not erase or rewrite member state. The original failure then returns for an unbound legacy journal containing a representative question. Rig leg H and exact-head ordinary review/CI are tracked separately from these local checks.
