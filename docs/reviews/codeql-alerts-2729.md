# CodeQL main-alert triage (#2729)

Read-only API snapshot:15 open alerts on `refs/heads/main`, numbered81–96 with91 absent. All15 latest instances come from `.github/workflows/codeql.yml:analyze`, JavaScript/TypeScript, at0294441ab5292b8ac779a7e2d9d5f03d6c686496. The source baseline for this fix is f4b80d87a. This report classifies the actual code and trust boundaries; the scanner's severity is not proof of an externally exploitable flaw.

No shipped runtime vulnerability was established in these15 findings. `package.json.files` excludes these tests/manual scripts/CI checker (the only shipped `scripts/` entry is `scripts/preinstall-guard.cjs`). They still deserve review: tests and manual tools execute code, create sessions and control private fixtures.

| Alert | Rule / location before fix | Triage and change |
| --- | --- | --- |
| [81](https://github.com/songsid/AgEnD/security/code-scanning/81) | incomplete URL substring; `smoke-2453-named-link-authority.mts:40` | Harness presentation false positive, not URL authorization. A fixed-host substring was testing visible label text. Assert the complete EN/zh-TW localized label instead. |
| [82](https://github.com/songsid/AgEnD/security/code-scanning/82) | incomplete URL substring; `web-authority-named-link-2453.test.ts:201` | Test presentation false positive. Authorization is asserted independently; the host substring grants no trust. Assert the complete named-link peer phrase, preserving receipt/authority/internet assertions. |
| [83](https://github.com/songsid/AgEnD/security/code-scanning/83) | bad code sanitization; `smoke-2478-composer.mts:38` | Pattern worth fixing. Selector is one of two constants, with no demonstrated injection; pass it as `page.evaluate` data, not serialized JavaScript source. Preserve the clip/screenshot sequence. |
| [84](https://github.com/songsid/AgEnD/security/code-scanning/84) | bad code sanitization; same file:41 | Same trust boundary. Pass the two cleanup selectors as an argument array, preserving both resets. |
| [85](https://github.com/songsid/AgEnD/security/code-scanning/85) | bad code sanitization; `smoke-usage-compact.mts:173` | Pattern worth fixing. Group selector comes from fixed device cases. Pass as evaluation data; preserve stale-mark removal and marking the final row. |
| [86](https://github.com/songsid/AgEnD/security/code-scanning/86) | bad code sanitization; same file:179 | Pattern worth fixing. Final-row selector is local fixture state. Pass as data; preserve focus/bar/rounded-corner geometry. Keep nested callbacks anonymous so tsx does not introduce a helper unavailable in the page. |
| [87](https://github.com/songsid/AgEnD/security/code-scanning/87) | incomplete URL substring; `web-authority-quick-link.test.ts:228` | Test presentation false positive. Assert the complete quick-link peer phrase; retain actual authorization, authority-kind and public-internet disclosure checks. |
| [88](https://github.com/songsid/AgEnD/security/code-scanning/88) | incomplete sanitization; `scripts/check-data-downgrade-workflow.mjs:23` | CI-only false positive with current fixed2.1.12/2.2.6 inputs, but worth removing. Stop constructing a regex from partially escaped text. Parse the baseline argument with a fixed regex, require exactly one call and compare the argument literally against the expected version. Actual failing probe and `pipefail` requirements remain. |
| [89](https://github.com/songsid/AgEnD/security/code-scanning/89) | incomplete sanitization; `kiro-2.34.0-audit.test.ts:159` | Pattern worth fixing. Existing three fixture literals lack the omitted metacharacters, so no current exploit. Use the complete conventional regex escape, including backslashes, while retaining prefix/count semantics. |
| [90](https://github.com/songsid/AgEnD/security/code-scanning/90) | incomplete sanitization; same file:160 | Same correction for the older-version absence check; expected count0 remains. |
| [92](https://github.com/songsid/AgEnD/security/code-scanning/92) | incomplete URL substring; `windows-network-check-2650.test.ts:168` | Non-authorizing test, but weak assertion worth fixing. Count exact `https://songsid.github.io/` requests, rather than a hostname appearing anywhere. |
| [93](https://github.com/songsid/AgEnD/security/code-scanning/93) | incomplete URL substring; same file:169 | Count exact `https://raw.githubusercontent.com/` request; retain one-attempt expectation. |
| [94](https://github.com/songsid/AgEnD/security/code-scanning/94) | incomplete URL substring; same file:170 | Count exact `https://registry.npmjs.org/` requests; retain two attempts. Apply the same exact comparison to the adjacent Kiro retry assertion. |
| [95](https://github.com/songsid/AgEnD/security/code-scanning/95) | bad code sanitization; `windows-stage-recovery-2650.test.ts:83` | Pattern worth fixing. Temp root is generated locally and JSON serialization is valid for this Node context; no attacker source established. Pass root via child environment JSON and parse as data inside a static stub. Preserve real generated SQLite-program execution, broken/valid module controls and process allowlist. |
| [96](https://github.com/songsid/AgEnD/security/code-scanning/96) | bad code sanitization; same file:115 | Pattern worth fixing. Health status comes from a fixed test table. Pass HTTP/status/startup/page values as child data, preserving degraded warnings and down/incomplete/unavailable-page failures. |

## Scan-policy proposal: retain current coverage

Do **not** add `paths-ignore: [tests/**, scripts/manual/**]`. Fixing the inexpensive patterns removes the present noise without changing which code is analyzed. No workflow, query filter, scan configuration, suppression or alert-dismissal API is changed by this PR.

Such exclusions would hide future problems in generated Node/PowerShell snippets, private fixture cleanup, browser/session setup, ownership checks and accidental real-service/process calls. Non-shipped does not mean incapable of harming a developer or CI environment. A blanket `scripts/**` exclusion would additionally hide the CI checker and shipped preinstall guard and is especially inappropriate.

If a future deliberately hostile test fixture produces an unavoidable finding, triage that exact finding with the leader rather than disabling the rule/path globally. This assignment does not authorize dismissing any alert; none is dismissed through the API.

GitHub documents [analysis path filtering](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options); it removes files from analysis and differs from workflow trigger filtering. CodeQL documents why [code/data construction](https://codeql.github.com/codeql-query-help/javascript/js-bad-code-sanitization/) and [partial escaping](https://codeql.github.com/codeql-query-help/javascript/js-incomplete-sanitization/) need care.

## Validation and safety

The new boundary tests extract only the changed evaluation callbacks, transpile them with keep-names enabled, reject browser-external helpers, and execute them in an inert VM with a tiny fake DOM. They verify literal selectors, marker clearing, three geometry points, focus/bar checks, and composer style reset. They never import or run a smoke module.

The CI checker is tested against private workflow copies with the original runner's empty baseline arguments. The runner fails before stores or packages are imported; tests prove the correct workflow succeeds as a negative-check harness, a wrong baseline is refused, and removal of `pipefail` is detected. No valid downgrade data phase or fleet handler is run.

Focused checks run in a capped1CPU/1GiB, networkless PowerShell7.4.2/Node22.22.2 container with private HOME/AGEND_HOME. No real browser, account, backend or fleet is started. Manual modules receive syntax-only compilation; no full manual smoke/rehearsal is claimed.

Final acceptance is operational: after review/merge, dispatch `codeql.yml` on the exact main merge SHA, verify analysis results are uploaded under the same analysis key, and read the real open-alert count and workflow outcome. Fixes should close findings through new analysis, not dismissal. Before that scan, the existing main count remains15; a local test pass does not imply alerts have closed.

Rollback is reverting this PR's test/manual/CI-checker changes; no runtime data or configuration migration exists. Scan coverage remains unchanged throughout.
