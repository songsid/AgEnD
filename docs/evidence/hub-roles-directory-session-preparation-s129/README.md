# Preparation-only directory session adapters

This packet covers the source delta over #3832 at `ce0f555923f86db748a04db32559053f964d0cca`. It does not activate the directory HTTP controller, register automatic cutover or close full S-129 acceptance.

The typed baseline `922103caa20510c8a8c63f081482fca3b9696d3e` refuses valid auxiliary preparation at five assertions, with four controls passing. The implementation checkpoint `7a532202fbf10235b551da62fcf42ad6375e04ed` accepts the same opaque preparation only for existing sign-in attestation and token-bound rotation staging. It retains the actual Core's source directory, configured root and epoch and refuses mixed proof envelopes. A preparation-marked rotation still needs fresh effect authority for the decision and fresh successor authority in the new generation.

The focused run covers 525 tests across eight files. The 32 new standalone cases cover slow preparation, all current identity/source/time fences, genuinely issued foreign-source handles, missing attestation, exact token ownership and private SQL root/auxiliary handoff. Two additional tests use the actual initialized sealed Hub, loopback HTTPS sign-in and mounted session projection. Native TS7 source and test checks pass.

Thirteen isolated guard reversals compile with the source compiler, each produces an intended assertion failure, and exact restoration is followed by the two changed suites. The public [receipt](receipt.json) binds every source/test file and recorded check. The [mutation records](mutations.json) bind each baseline, replacement, test input and restored image. Raw logs remain in the author's private artifacts; these hashes are not a claim of independent reviewer execution.

The directory responses are fictional. SQL successor controls use synthetic file-image hashes; they do not prove physical file installation, crash/WAL recovery, a mounted auxiliary Save response or cookie delivery. No browser, container, native-platform, backend CLI, real directory/account/Fleet or pilot run is included. Repeated identity checks on typed internal packets are defensive, without a separate necessity claim for every repeated source line.

Parent-first plain alpha synchronization, resolution review and exact-head CI/readiness remain required. The coordinator alone merges. See the [design and rollback boundaries](../../design/hub-roles-directory-session-preparation-s129.md).
