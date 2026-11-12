# Complete PR secret-scan range (#3745)

The pinned action's PR implementation makes one GitHub list-commits request,
then scans from the first to the last returned entry with first-parent filtering.
The default response contains 30 commits. A later introduction can therefore pass
PR scanning even when the push scan would detect it.

Source (checked 2026-11-12):
[the pinned action](https://github.com/gitleaks/gitleaks-action/blob/e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e/src/gitleaks.js).

## Replacement

For PR events, `scripts/ci/gitleaks-pr.sh` validates the event's full base/head
SHAs, refuses shallow, missing, disconnected or ambiguous history, computes the
unique merge base, and scans `merge-base..head`. It traverses side histories and
includes merge-resolution diffs (`--diff-merges=first-parent`, which does not
restrict commit traversal). No GitHub commit-list response determines the range.

The workflow downloads Gitleaks 8.24.3 and verifies its release archive checksum
before extraction. Push scanning still uses the existing pinned action, explicitly
set to 8.24.3. PR scans use the same `.gitleaks.toml` and `.gitleaksignore` files.
Scanner errors and findings both fail the job. Logs and SARIF redact findings.
Missing configuration or an unexpected scanner version also fails closed.

This retains the repository's existing policy of allowing PRs to change their
scan config and fingerprint ignores; changing that trust policy is separate work.

## Actual PR proof

Draft [#3747](https://github.com/songsid/AgEnD/pull/3747) is synthetic evidence,
**never a merge candidate**. At its 37-commit head
`a8ce50d5c722e5653e6e48acb69e7476a0800ba9`, commit 36 introduces an inert,
deterministically generated GitHub-token-shaped string; commit 37 removes it.
No real credential or account is used. A repeated-c control at commit 31 has too
little entropy to trigger the default rule; it is not used as the positive proof.

- [Old workflow run 43269112308](https://github.com/songsid/AgEnD/actions/runs/43269112308):
  SUCCESS, exactly 30 commits scanned, range ends at commit 30
  `bb5a53c3d60e3315fbbd7413ad33134336f2be4c`, zero findings.
- [Replacement run 43269447734](https://github.com/songsid/AgEnD/actions/runs/43269447734):
  expected FAILURE / exit 2, 38 commits scanned through its exact PR head
  `17f891216a26422aa84330af60f8a66dcff39cbb`, one finding. The extra commit
  installs the new workflow/helper; the synthetic credential history is unchanged.

The final helper additionally includes merge-resolution diffs; the offline
merge control below checks that behavior with the actual binary.

## Copyable offline controls

Obtain the official 8.24.3 Linux x64 binary and verify its release checksum, then:

```sh
python3 scripts/manual/gitleaks-range-3745/prove.py /absolute/path/to/gitleaks
node node_modules/vitest/vitest.mjs run tests/gitleaks-pr-range-3745.test.ts tests/gitleaks-config.test.ts tests/ci-notify-step.test.ts tests/ci-actions-pinned-2528.test.ts --maxWorkers=2
```

The Python rig creates and removes its own repository under `.artifacts/`, with
37 synthetic commits. It asserts the old first-page scan misses the known
fixture, the full scan and production helper catch it, the exact fingerprint
ignore works, and a later occurrence is still caught. A merge-resolution-only
occurrence must also be detected by both the scanner and production helper.
Only ranges, counts and exit codes are printed, never the fake token.

Local result: 6 real-binary controls pass; 92/92 focused tests pass (16 new).
Five independent semantic reversals fail the new suite: using the base tip instead
of the merge base, first-parent traversal, removing the version check, allowing
shallow history, and dropping merge-resolution diffs. The restored suite passes.
Test-only typecheck, shell syntax, pinned-action and changelog guards pass.
The local dependency supplier had an older js-yaml; these checks used the
lockfile's 4.3.2 in an isolated overlay without changing package files.

## Cost and rollback

Long-lived PRs now scan more history and can reveal previously missed findings;
use exact reviewed fingerprints for false positives, never a partial range.
There is no application/runtime change. Reverting this PR restores the old scan
and its known gap; a CI download failure should be repaired rather than bypassed.
