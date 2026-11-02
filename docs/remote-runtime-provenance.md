# Remote Runtime design references and provenance

## Design references

[Multica](https://github.com/multica-ai/multica) was a product and high-level architecture reference for this work. The requested workflow used Multica screenshots to illustrate selecting a computer and Runtime first, configuring the Agent in a separate step, then completing setup. The machine-local Runtime concept was also an explicit reference.

This PR does not vendor, import or depend on Multica. The reviewed implementation extends AgEnD's existing Fleet, native Windows worker, shared Instances/chat and scoped MCP surfaces, with AgEnD-specific pairing, protocol, execution-journal and recovery handling. Product inspiration is acknowledged here separately from the source/dependency audit below.

## Source review scope

A review on 2026-11-02 compared the 44 changed `src` files between AgEnD base `abdf6822fde607d24590fdb9eb3bc7851689ba1d` and feature snapshot `8c1feb457700aaef0c54b7c976ffd5757226c4bb` against 137 non-test files covering Multica's daemon, Agent creation and Runtime at [Multica commit 4696eab](https://github.com/multica-ai/multica/tree/4696eab2caa912b48aabfc4fa4e94662209b265b).

The comparison found no identical non-comment source lines of at least 65 characters after removing whitespace, nor the checked AgEnD runtime protocol identifiers in that Multica source set. A repository/dependency review did not identify incorporated Multica source, vendored assets or runtime dependencies in these changes. This is a bounded source review: it is not a clean-room claim, an exhaustive comparison of every Multica revision, or a determination of semantic derivation. Specific source-reuse findings should be reviewed individually if raised.

Multica's [license checked at commit 3794359](https://github.com/multica-ai/multica/blob/3794359792e1e310d89d0488b46efff66e9d2369/LICENSE) is a custom Multica License containing additional terms alongside Apache License 2.0. It should not be described as an ordinary Apache-2.0 dependency. This document does not import Multica code or offer a legal conclusion about future reuse.

## Bundled code and assets

- The portable Runtime contains AgEnD program modules and the reviewed `ws` dependency. Both the build script and the installed-package ZIP download include AgEnD's root `LICENSE` and `ws/LICENSE`.
- The Runtime has no Multica dependency and does not launch a Multica daemon or CLI.
- The dashboard's existing provider marks come from the official product/publisher sources recorded in [Third-party notices](../THIRD_PARTY_NOTICES.md#cli-provider-marks). Those marks were introduced in #2934 and are reused by this PR; they are not sourced from Multica screenshots or assets.
- Existing unrelated third-party notices remain in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
