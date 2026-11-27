# Fresh private leaf checks

A private-file read checked its leaf twice: once during path validation and again for the size limit. The candidate uses one final leaf stat after canonical-path resolution for type, UID, mode and size. Every ancestor, canonical path and file/floor read is still checked on every call. No path, metadata, authority or frame result is cached.

Public `privatePath` calls, including directory callers and writers, use the same checker without a size bound. A genuinely missing path retains native `ENOENT`; a dangling identity-directory symlink remains unsafe rather than being interpreted as an unprovisioned Hub. FIFO and device leaves are refused before any read. Strict UTF-8/BOM handling is unchanged. The existing pathname stat-to-read window remains; this is not an fd-based race fix.

## Validation

The baseline produces five assertion failures and eleven positive controls. The candidate passes 132 tests across eight named writer/database/TLS/helper/floor suites, one additional canonical-path replacement control and two post-metadata-fix file-floor/scalar integration controls: 135 distinct controls, with overlap excluded. The final new file has 19 passing controls. Both source and test typechecks pass. Eleven unsafe mutants fail assertions (ancestor/final-leaf/UID/mode/type/canonical/size/dangling-link/cache/UTF-8/directory checks); the runtime source is restored byte-exact afterward. The last typing adjustment only handles the mocked `lstatSync` undefined return.

## Matched synthetic measurements

Baseline is the actual metadata-read merge `490ae07b87bd1209e37d7c7a7548e3f8213f9bc0`. Each bundle binds 245 Hub modules; only `src/hub/private-files.ts` differs. Separate processes run baseline then candidate on the same two-vCPU VM with the same fixture and Node 22.23.5. Each endpoint has one untimed priming request and three recorded requests. The three principal reads and sixteen available admin reads all return HTTP200; three unmounted conditional routes return HTTP404 and are excluded. All 132 recorded rows are classified.

Every row retains equal private-file, floor and transport read counts. Explicit private-file `lstatSync` calls fall from five to four per read in this fixture (20%). These counters exclude filesystem work internal to `realpathSync` and `readFileSync`.

| Principal read | CPU median before → after (ms) | Explicit stats before → after |
| --- | ---: | ---: |
| Exposures | 664.9 → 655.4 | 26860 → 21488 |
| 70-post room detail | 855.1 → 855.6 | 36450 → 29184 |
| Room list | 219.2 → 219.7 | 8770 → 7016 |

There is **no established material CPU improvement** on these three reads. Admin medians and all ranges are recorded in `verification.json`; they vary and are not presented as a causal speedup. Process counters can include interleaved work (the room-detail medians contain 7290 versus 7296 reads), so cross-process counts are not claimed identical. This patch removes proven duplicate filesystem work; no response-time target, live improvement or browser result is claimed. No production profiling, configuration or restart was performed. Owned synthetic scratch processes exited and their scratch directory was removed.

## Rollback

Revert this PR's private-file helper change. It changes no persistent format, migration, timers, retries, production settings or protocol. Reverting restores the previous duplicate leaf stat; keep the metadata-reader fix independently.
