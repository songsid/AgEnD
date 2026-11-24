Codex replay accounting — M-3673

Codex context forks can replay historical `token_count` records with new outer timestamps. The turn ID and cumulative/per-request usage remain stable. A pathname cursor plus same-file cumulative-total suppression counts that inherited history again when it appears under a new filename.

The reader now hashes the turn ID and normalized numeric cumulative/per-request usage. It retains the original event time, advances each file's parser/session state, and excludes duplicate token, gap and speed additions. Distinct turns and distinct cumulative requests within one turn remain separate. Legacy records without a turn ID keep the conservative per-file behavior.

Ancestry is resolved before charging descendants, including parents outside the ordinary modification-time window and ancestors from a different workspace (identity-only there). Missing or cyclic ancestry leaves collection incomplete. An unfinished trailing line does not cause a retry loop. Only the session ID, parent ID, working directory and inode are cached from session metadata; account and prompt fields are not retained.

A durable candidate repairs retained recent Codex contributions while the old published generation stays visible. It resumes across restarts and commits only after the inventory is readable and caught up. Other readers' totals, old hours awaiting durable folding, daily rollup checkpoints and lifetime archives are preserved. Mixed-reader legacy gap records have no source tags: those historical gaps are retained, rather than erased or added again. The repair does not reconstruct lifetime archives or infer missing source data.

Validation uses synthetic fixture data. The original service regression fails on the base: a copied old request incorrectly contributes to today's count. Its distinct-request positive control passes. Regressions cover inherited dates, restart/append, rate-limit announcements, same-turn requests, old ancestors, missing/cyclic ancestry, foreign workspace ownership, interrupted migration, unrelated-reader preservation, unfinished lines, old unflushed hours, and speed/gap suppression. See verification.json for commands and source bindings.

Private offline numeric recounts and an independently installed reporting tool were compared without network access or submissions. Raw source records, local identities, private totals and machine paths are not included here. No live account, CLI, Fleet restart, browser or UI campaign was performed. The company reporting wrapper was inspected read-only; it is not changed by this PR.

Rollback: revert the reader changes. The prior reader ignores the additional optional ledger fields. Do not restore replay-inflated totals or alter source transcripts as part of rollback.
