# Final queue sync after #3726 and #3706

This is a clean plain merge of approved `e14972a4defdf0300bc0259d12931ae52b5baacf` and alpha `7ae6a6676d95912a773a3ce4a8adef06d33fc0d3` (#3706, after #3726). No conflict, rebase or force-push.

[Git audit](source.json) binds the source merge, parents, tree and every changed path. Incoming changes and this PR's changes are disjoint. Every incoming blob exactly matches alpha; every prior own blob exactly matches approved e14972a4. The net production delta is still the four R4 Settings/navigation files. No annotation, enrolment, message, authority or visual change is introduced by the merge.

Prior 113/113 focused tests, native typechecks and the accepted R4 gallery retain their recorded heads and scope; no new local suite or browser execution is claimed. The unchanged evidence and product blobs do not need another capture. Fresh exact-head CI and Fable confirmation are required on the submission. Parent #3732's post-merge CI passed. Both preceding queued PRs are merged; coordinator alone gates/merges after Leader release. Rollback is a UI revert without migration. No live account, Fleet, CLI, AD or pilot work.
