M-3498 main fix twin

Dev [#4308](https://github.com/songsid/AgEnD/pull/4308) merged as d8a9f8c923191a0f90d037b1d47ec7901ae7a893 after the beta.17 freeze lifted. Main has the identical whole-document serialization call in `saveFleetConfig`, so this twin carries the same formatter and call-site fix.

The formatter is byte-identical to the approved dev component. Add-only mapping writes insert into the existing source ranges and validate the parsed candidate against the intended AST. Semantic no-ops keep the source bytes. Unsafe structural/alias shapes retain the existing guarded AST writer with wrapping disabled. Existing validation, alias isolation, fsync, mode and atomic replacement remain. Exact spacing retention is not claimed for structural rewrites needing that fallback.

Main has no host-monitoring runtime or beta.16 fixture, so its two integration cases add main's existing `web.usage_panel` and `web.echo_to_channel` booleans in memory, call the real `saveFleetConfig`, then reload through main's reader. This exercises the same add-only writer without adding monitoring to main. Both absent and partially persisted web mappings must keep every existing line exactly, including the long quoted instruction, nested inline maps, compact spacing and comments. The second save is byte-identical.

Validation:

- Main base writer: both add-only integration cases fail by formatting assertion (the formatter module is present only as a test dependency; the old writer still runs).
- Main existing alias/refusal/slimming/save/display-name suites39/39; final formatter integration9/9 (48 distinct cases). Test type-check exit0.
- An initial adapter using a nested unknown monitoring field hit main's existing changedOutside guard; that fixture was corrected to known WebConfig keys, not used as failure proof and did not change production guards.

- The nine format cases retain dev's CRLF, nested section insertion, flow replacement/comment, sequence-entry, shared-offset, alias isolation and normal-value-edit coverage.
- Formatter equality means dev's two compiling reversal controls carry: removing semantic comparison breaks alias isolation; restoring80-column wrapping breaks long-line preservation. They were not repeated on this identical component.
- Dev's actual startup/closed-runtime tests and shipped beta.16 reader check remain on the dev PR, already passed; they are not backported as a new main feature.

Reproduction:

```sh
npx vitest run tests/fleet-yaml-format-m3498.test.ts tests/yaml-shared-nodes-2208.test.ts tests/yaml-shared-nodes-guard-2208.test.ts tests/fleet-yaml-slim.test.ts tests/fleet-yaml-save-guard-1056.test.ts tests/fleet-yaml-display-name-2842.test.ts --maxWorkers=1
npx tsc --noEmit -p tsconfig.test.json
```

No live config/provider/pane/Fleet lifecycle or browser campaign. The shared dashboard skill and bilingual fix note are updated. Rollback restores the original serializer/call-site; no schema, migration or permission change.
