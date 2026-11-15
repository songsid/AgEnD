# agy verified session switching (M-3180)

The old model path always restarted, and the effort path pasted without a version gate or a verified result. This adapter joins #3997's shared idle-only, running-version-gated switch route. Fresh exact agy command responses prove the target; absent catalog/unsupported version/busy/refused/unconfirmed switches retain the saved target and restart.

The agy floor is 1.4.7, the oldest retained complete contract tested, with the same layout rechecked on 1.5.9. It is not a claim about the command's introduction date. Actual copied binaries ran only in owned mount/PID/network namespaces, against namespace-only loopback fake OAuth/catalog responses. No real credentials, model calls, host pane or Fleet was used. Fixtures and binary hashes are in tests/fixtures/agy-model-switch-3180.

The production Daemon/TmuxManager route verified both commands on 1.5.9 (daemon-proof.log). The scratch copy is placed in a versioned releases directory only after its own netless --version matches the label, so the ordinary static running-version path works even when nested unshare is unavailable. Initial rig composition attempts failed on a missing launcher mount and an unknown version; no unsupported command was typed. No production gate was bypassed.

Tests: the new integration suite without the table entry fails 6/7 (fail-first.log); restored adapter plus pure proofs and shared Muse/Fleet/daemon suite pass 36/36 (focused.log). Source and test typechecks pass. Configured supported effort is included through the optional shared modelWant hook; backends without it retain existing behavior.

Risk: future agy response/catalog changes can conservatively restart. Screen proof is restricted to a new owned command exchange, never an old footer. Rollback: remove antigravity from CLI_RUNTIME_SWITCH to retain model restart; removing this PR restores the former behavior completely.

Audit checklist: scripts/manual/agy-version-audit/README.md. Full authenticated vendor behavior and arbitrary model availability are outside this mock capture.

R1: the actual Grok daemon composition exposed that the shared parser treated a model+effort spec as malformed and downgraded it to raw input. The parser now accepts an entry-representable single command with either/both values, verifies the exact wire command, and refuses malformed CLI specs before queueing any write. Shared malformed-spec assertions now require no input and a not-sent verdict. The agy end-to-end IPC/queue test asserts gate + verifier calls for configured effort; a mismatched wire is refused. Affected shared/agy suites pass 38/38; strengthened actual-route test passes 9/9. Both typechecks pass.

R2: a replacing version-probe callback reproduced a separate running-version race: the old helper returned the newer disk file's version for the older running inode. It now rechecks every matched running process and its disk executable against the original inode/device after version resolution. The fail-first case is red before the fix; shared + agy integration pass 34/34 afterward, and both typechecks pass. This shared helper change applies to agy/Grok and leaves an unproven version on the restart path.
