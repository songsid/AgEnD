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
