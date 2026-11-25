# Bounded release-base integration

Prism cleared source at `cddc5d7b88638c1b38900bdd62a7648ae5da07ca` (review6043335387), but the PR was actually CONFLICTING/DIRTY and had no registered exact-head Actions. A plain merge incorporates current release `a12b8fe3243fe7908fc58a0742be26095fca1e3f`, including the already merged Codex audit SIGPIPE fix `c0cb46de` and the upstream agent-character feature. No rebase or history rewrite.

Three conflicts were capability declarations in hub/server.ts, compose/server.ts and http/compose.ts. Resolution preserves both the explicit room-asker identity negotiation and incoming character offer/modern-welcome gating. Auto-merged client/member flags and locale changes retain both features. No asker signature, actor mapping, companion/GC/orphan/retention or input policy was changed by the integration.

A combined-capability control pins both offers and their absence for a legacy peer. Focused negotiation, actual member composition, incoming character/picture controls and the fake-only Codex audit regression passed51 tests/5files. The shell fixture uses no Codex/tmux/network. Test types and full build/postbuild exited0. The inherited visual campaign was not repeated.

`sync-bindings.json` records both parents and the three resolution inputs/results. All73 incoming-only paths and11 own-only production paths compare byte-equal to their respective parents; only the shared integration surface required review. The zero-context resolution patch is relative to the incoming release. Prior source/evidence clearance carries for unchanged policy; all earlier campaign stages remain scoped to their recorded inputs.
