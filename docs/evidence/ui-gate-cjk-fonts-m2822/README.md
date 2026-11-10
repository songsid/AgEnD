# M-2822: bounded CJK font preparation

The control is main `bbff8ae42aeab2371b7d6de9b89948ec76a36d59`. Its successful retry of [UI gate run 42778521465](https://github.com/songsid/AgEnD/actions/runs/42778521465/job/129707206071) installed `fonts-noto-cjk` `1:20230817+repack1-3` and passed 94 checks. The earlier cancelled attempt remains the reported failure; the retry does not fix it.

The new helper pins that exact Noble archive, its four TTC files, and its package Fontconfig rules. It extracts privately, without root, package installation, hooks, or apt indexes. The generated Fontconfig includes the runner's existing rules plus the package's regional aliases; it does not invent a new font preference. Both regular and bold Traditional Chinese faces must resolve to pinned font bytes before the gate runs.

- [Official Ubuntu Noble package download and checksum](https://packages.ubuntu.com/noble/all/fonts-noto-cjk/download).
- [Pinned archive](https://archive.ubuntu.com/ubuntu/pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817+repack1-3_all.deb).
- [Pinned actions/cache implementation](https://github.com/actions/cache/commit/caa296126883cff596d87d8935842f9db880ef25).

Cache restore and save are optional, each capped at one minute; restore also has a one-minute segment limit. There are no prefix fallback keys. Every archive hit is verified again. A cold or corrupt entry gets one HTTPS download: 10-second connection limit, 45-second total, no retries, and a 50-second child-process limit. Extraction, font-cache generation, and face selection have separate 20/20/5-second limits. Failure exports no usable FONTCONFIG_FILE and leaves no partial download or owned extraction. Saving happens after the gate, so cache upload cannot delay the measurements. The job's existing 10-minute deadline and all gate assertions, matrix cases, and tap allowances are unchanged.

No font binaries are committed. An upstream archive deletion or cache outage can fail preparation clearly; the fix deliberately fails rather than silently using different glyphs. Rollback is a normal revert of the workflow/helper/test commits. Runtime and application data are unaffected.

The release branch inventory finds the affected UI-gate/apt step only on `release/2.3.5-alpha`. Six older release lines have no such job and need no new font dependency. Land main first, then the alpha twin.

Execution receipts and control comparisons will be added separately, with the exact source commit and honest local-versus-hosted scope.

## Executed controls

`accept.mjs` ran from committed source `fc97c3278d463badd6f7a9eadb18b671487c5e4f` against detached control `bbff8ae42aeab2371b7d6de9b89948ec76a36d59`. The receipt records both trees and equal product, smoke and fixture input trees, plus the exact helper, pin and harness digests. Subsequent changes only add the TypeScript declaration, changelog metadata and these receipts; runtime/helper/workflow bytes are unchanged.

- Cold: the real official 61 MB archive downloaded, verified, extracted and selected in **11.405 s**.
- Warm/offline: a `curl` stub that would fail any invocation remained unused; the verified cache prepared in **3.754 s**.
- Held TLS: an owned loopback peer accepted a connection but sent no handshake. The actual curl failed in **10.018 s**, with `SSL connection timeout`, an empty cache and no ready output. The peer's physical exit was acknowledged.
- Glyphs: **32 canvas/DOM metric rows per preparation**, system UI and explicit Noto TC, regular/bold, two sizes, four Chinese/mixed samples: **exactly equal**.
- Original `GATE=ci`: **94/94 checks on each preparation**, complete results equal after excluding duration (38 s control, 41 s candidate). No section, assertion, fixture or tap allowance changed. All screenshots were generated locally; this is a font-preparation comparison, not a UI change or a new full-matrix claim.

The local control reconstructs the apt-installed Fontconfig inputs in an owned directory, placing the package's `70-*` rule at its normal sorted location among copies of this machine's system rules. The candidate uses the actual helper. Both use the same Chromium, isolated empty XDG config/data directories (to exclude the developer's personal font aliases), system fonts and unchanged product tree. This proves the preparation delta on a control head; it is **not** a fresh GitHub-hosted apt run. The hosted retry above independently supplies the original package/version and 94-check result. Candidate hosted CI is reported on the PR separately.

Reproduce after creating a detached control checkout at the recorded control SHA and linking dependencies:

```sh
PW_DIR=<directory-containing-playwright-core> CHROME=<same-Chromium> \
  node docs/evidence/ui-gate-cjk-fonts-m2822/accept.mjs
```

`OUT` must be a fresh owned directory. The harness uses `../../.artifacts/t2822` as a short scratch directory, and an optional `.artifacts/deny-bin` of exit-97 native/lifecycle stubs. The original smoke fixture owns and drains the browser, loopback listeners and scratch home without starting a fleet.
