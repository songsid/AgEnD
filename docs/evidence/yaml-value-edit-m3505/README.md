M-3505: edit fleet.yaml scalar values without reflowing their neighbours

Root cause: M-3498's source-preserving path accepted only additions. Any changed scalar made `onlyAdds` fail, sending the entire document through YAML AST serialization. Also, its collector serialized a changed flow mapping as a whole before checking whether any key was actually added. This made a monitoring toggle reformat unrelated multi-line flow mappings even with line wrapping disabled.

The collector now replaces a scalar's own original source range. Plain/quoted scalar comments and spacing outside that range remain byte-identical. Changed strings are safely quoted on one line; a block scalar's body is part of its edited range, while its header comment and following line separator are retained. Empty null ranges receive the separators needed to keep comments and adjacent keys valid. Equal-length sequences can contain these edits. Flow mappings are serialized as a unit only when a key is added, as before.

A scalar alias can be replaced at its token. When editing an anchored scalar causes the existing isolation helper to materialize another scalar alias, that token is materialized too; it must not follow the newly changed anchor. Unrelated aliases/anchors stay untouched. Every candidate is reparsed and must equal the intended document data before it can be returned. Existing Fleet save validation, changed-outside guards, atomic writes and fsync remain unchanged.

Structural removals, sequence resizing, scalar/collection kind changes and materialization of a mapping alias use the existing AST fallback with `lineWidth:0`. Such edits can reformat collections. Unowned/unsupported source shapes or a failed candidate equivalence check also retain that conservative fallback; byte preservation is claimed for supported scalar ranges and additions, not arbitrary YAML graph transformations.

Proof:

- Initial17 valid cases on the original formatter:14 assertion failures,3 structural-fallback positives. The actual Fleet saver reproduces the unrelated flow-map reflow. Earlier invalid block/alias fixture indentation was corrected and is excluded from this proof; the final helper explicitly refuses parse errors.
- Fixed affected run:8 files,99 tests passed, including17 new cases, M-3498 additions, alias/unshared-node guards, Fleet save validation, monitoring sidecar/settings and slim-config behavior. Test types exit0. Runs overlap and are not summed.
- Exact full-file assertions cover flow/block mappings, long lines, inline/header comments, CRLF, sequences, empty/null values, quoted/newline strings, scalar aliases and anchored-scalar isolation. Structural fallback cases pin both serialization path and resulting data.
- The beta.16 reader fixture remains unchanged. The new beta.17 reader fixture is byte-identical to `v2.4.0-beta.17` commit506acdf29ab9a3937aabceb5d40e90b08e13a826, `src/host-monitoring-config.ts` (SHA-256 `000605d975880eda9945bab994d4a55428552b430b09087dbb0682b4a62dee4c`). Both readers accept the exact bytes written by the toggle save. Idempotent second saves leave those bytes unchanged.

R1 fixes one source-review finding: an equal-data sibling map/sequence can contain scalar aliases materialized by an anchor edit. The equality shortcut now descends concrete maps/sequences so those alias tokens are reached; collection aliases remain structural fallback cases. Two exact-byte nested map/sequence controls fail on the prior head and pass after the correction, preserving each alias's own comment and the unrelated multi-line web flow. Focused formatter suites:28/28 passed (19 new +9 M-3498 cases); final test types0. The original99-test run remains earlier overlapping evidence; no broad campaign was repeated.

This is a formatter fix with synthetic fixtures; no live config, host monitoring, Fleet, provider or pane was mutated. No visual change or browser campaign. Dev PR remains DRAFT on the beta.18 release-freeze HOLD until the release ships and the Leader explicitly lifts it. The main twin follows the actual dev merge.

Rollback: revert this scalar-splice extension and its tests. The previous add-only path and guarded no-wrap AST writer remain available; no schema, migration or dependency change.
