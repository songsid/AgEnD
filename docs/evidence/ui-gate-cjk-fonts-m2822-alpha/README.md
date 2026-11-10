# M-2822 alpha twin

Main landed first: [#3566](https://github.com/songsid/AgEnD/pull/3566), squash `3ff2d9e2f56e34ad9137b7380290fcb92d16c2e7`. The helper, declaration and pin here are byte-identical to that reviewed version. The official archive checksum, four TTC hashes, package regional rules and exact TC face checks are unchanged.

[Main's control evidence](https://github.com/songsid/AgEnD/tree/ec6a6cd391bbc8680c58fcbb100242e9692a7321/docs/evidence/ui-gate-cjk-fonts-m2822) retains its original scope: 32 equal glyph metric rows, equal 94-check local control/candidate results, real cold/warm/held-TLS controls, and the independent hosted candidate cache miss. These are not relabelled as new alpha executions.

Alpha keeps its existing **15-minute** job deadline. All three existing commands, matrices, assertions and tap allowances remain: Settings UI gate, Hub UI gate, Hub shell gate. Each receives the helper's verified `FONTCONFIG_FILE`. Cache save runs after all three. The shell diagnostic still runs after a layout failure, but now also requires successful font preparation; a preparation failure cannot silently measure fallback/tofu fonts.

Fresh alpha author checks on base `ead0d7bd3`: 150/150 across font preparation, action pins, PowerShell preparation and the two changelog suites; test typecheck and diff check pass. The actual helper also prepared a verified cache hit in a fresh owned extraction and exported its Fontconfig path, with regular/bold TC faces validated. No repeated cold download or full browser matrix is claimed. The alpha hosted gate results will be reported on the PR at its exact head.

The font twin is synced with the landed M-2829 test-only isolation fix before its first push, preventing the known unrelated real-probe-worker journal failure from contaminating this CI run. Alpha.11 has shipped and the leader cleared the hold. Six older release branches have no affected CJK/UI-gate job and require no new dependency.

Failure and rollback match main: optional bounded cache steps, one bounded HTTPS fetch, no apt or retries, strict checksums before use. If cache and archive are unavailable, fail clearly. Revert this workflow/helper/test change normally; no runtime data or product behavior changes.
