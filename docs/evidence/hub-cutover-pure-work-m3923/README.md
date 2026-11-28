# Hub pure-work and scalar-version CPU fix

The measured prototype at `548dedf2ee76486853dd63fc3f6c2ca304dfdf0e` adds P (one exact-byte, per-clock memo of six frozen cutover facts) and S (checked scalar reads in audit and the group-version callback). Every fresh authorization/currentness/floor/confirmation check remains. The larger exclusive-ownership design is separate work.

Open [measured-report.html](measured-report.html) for the complete primary, capacity, residual-profile, control and evidence-hash report. The report is the byte-identical measurement snapshot accepted before the shipping decision; its statement that shipping awaits that decision is historical. Shipping was subsequently approved as a partial CPU fix for 2.4.0. [bindings.json](bindings.json) binds all eight tested source/test paths, full source-snapshot digests and the individually killed mutants.

## Measured result and release wording

Against a fresh #4614 baseline, mean gross process CPU falls from 4544.2 to 3672.6 ms with one tab and from 9687.0 to 8101.8 ms with three tabs (VM-normalized, three repetitions each): 19.18% and 16.36%. P alone clears the predeclared 5% gate; S's marginal 3.51%/0.67% is too small to establish reliably with these samples. All exact final/idle checks pass.

Release wording approved for the combined reduction since beta.28: **about a third less Hub CPU per message than beta.28 (synthetic measurements)**. The additional reduction in this PR is the 19.18%/16.36% comparison against #4614 above; the beta.28 wording includes the previously shipped reduction. It is not another measured 32% incremental saving from this PR.

The 100 ms mean/250 ms p95 targets remain missed. Both fresh six-step capacity ramps pass only the observed one-user level; three-user P+S page p95 is 3392 ms. Expired receives, closed streams and censored projections at overload are retained as failed capacity points. Short synthetic ramps do not establish a sustainable production maximum.

## Validation and scope

- P: 39 clock and 6 helper tests pass. Three new parser-count controls fail by assertion on the baseline; retained safety controls pass both versions.
- S: 30 tests in the two affected files pass. Two new scalar-use controls fail by assertion on the exact baseline; three safety controls pass.
- Eight unsafe variants across conditions (a)-(f) were run separately and killed by their intended controls; source bytes were restored after each.
- Source and test native typechecks exit zero. No typecheck or benchmark was repeated for this evidence-only packaging commit.
- One bounded container at a time: pinned logical CPUs 0 and 2, aggregate quota 0.758 CPU, 1 GiB RAM, Node heap 512 MiB. CPU factor 1.32 is the supplied current VM approximation; wall latencies are not scaled again. All containers and the private network are removed.
- Full native Hub HTTP/SQL/signing/audit/private-floor paths use synthetic fixtures, an immediate complete directory, and a controlled member receive seam. Local mock reply chunks run for about 20 seconds, followed by the supported whole final-answer frame. No live Hub, Fleet, directory, provider or native CLI traffic.
- Residual sampling is excluded from primary and capacity numbers; phase percentages are not a complete CPU ledger. Raw files remain hash-only private evidence unless transferred for independent review.

Rollback: revert this PR to restore full marker parsing and the two owning version reads. No schema, migration, authority boundary, timer, retry budget or deployed data changes.
