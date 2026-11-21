M-3498: preserve fleet.yaml formatting during automatic additions

The running fleet re-read the file into a source-aware YAML document but serialized the entire document with the library defaults. That wraps long scalars and flow collections at80 columns. Disabling wrapping alone still normalizes unrelated compact spacing/aligned comments, so it does not meet the add-only byte-preservation requirement.

The writer now splices mapping additions at the original source ranges (including mapping entries within an existing sequence). Existing text is retained; only a changed inline mapping is reprinted. A semantic no-op returns the original source. Before selecting the spliced output, it is parsed and compared with the fully patched AST. If an unusual source shape or alias detachment cannot be represented safely this way, the existing AST writer is used with wrapping disabled. This fallback retains alias isolation and the existing validation/atomic write path; arbitrary whitespace preservation is not claimed for structural edits that need alias rewriting.

The startup fixture exercises the real `startHostMonitoringRuntime` → `saveFleetConfig` path with absent or partially persisted monitoring. It contains a quoted long instruction, nested inline map, compact unknown-extension map and comments. Every original line is compared exactly, both default-off booleans are checked through the shipped beta.16 reader, and a second save is byte-identical. No live configuration, provider, pane or Fleet lifecycle command is used; monitoring stays disabled and the owned scratch runtime is closed.

Validation:

- On base: both real-startup formatting cases fail by assertion.
- Affected run:64/64 across eight focused files (new formatting cases, monitoring lifecycle/sidecar beta.16 compatibility, alias isolation/refusal, slimming, save validation and display names).
- Formatting edge cases cover nested block insertions before another section, CRLF, flow-map comments, sequence-entry mappings, shared end offsets, alias isolation and normal existing-value edits without wrapping.
- Final flow-style delta:9/9 formatting cases (eight overlap the affected run), including replacement of a whole inline map with an extended mapping. Test type-check exit0; changelog and whitespace checks pass.
- [Compiling reversal controls](controls.json): removing the semantic comparison breaks alias isolation; restoring80-column wrapping breaks the existing-value long-line check. Both fail by assertion; source restored afterward.

Reproduction:

```sh
npx vitest run tests/fleet-yaml-format-m3498.test.ts tests/host-monitoring-fleet-m3454.test.ts tests/host-monitoring-sidecar-s213.test.ts tests/yaml-shared-nodes-2208.test.ts tests/yaml-shared-nodes-guard-2208.test.ts tests/fleet-yaml-slim.test.ts tests/fleet-yaml-save-guard-1056.test.ts tests/fleet-yaml-display-name-2842.test.ts --maxWorkers=1
npx tsc --noEmit -p tsconfig.test.json
```

Release constraint: dev first, held until beta.17 ships and the release freeze is lifted. Main has the same `String(rawFleetDocument)` writer path, so its fix twin follows the actual dev merge. No UI or browser campaign is needed. The affected dashboard skill and bilingual changelog are updated.

Rollback reverts the formatter and call-site change. Existing configuration files require no migration; validation, alias isolation, permissions, fsync and atomic replacement are unchanged.
