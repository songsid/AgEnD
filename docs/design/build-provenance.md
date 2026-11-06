# Installed source-build identity

A packed branch-tip build can retain the repository's baseline package version.
That version alone does not identify the installed alpha code. Human-facing
diagnostics now show the source ref and commit separately from package SemVer.

`npm run build` writes `dist/build-provenance.json` after TypeScript compilation.
It records the checkout HEAD, a bounded ref, and whether tracked or untracked
changes were present. `git archive` retains the exported commit and ref through
`scripts/source-build.txt`; its change state is **unknown**, never clean. A build
without either source uses unknown provenance. Packing includes the fixed stamp
in `dist/`; packing alone does not restamp possibly older compiled code.

Inspect an installed package with `agend build-info` or `agend build-info --json`.
Hub setup prints the build identity before asking its questions. Fleet Settings
shows the alpha label and short SHA, links to the full commit, and keeps package
SemVer in the tooltip and accessible label. Phones use `α·<7-character SHA>`;
the full version, SHA and change state remain in that label. Modified and unknown change states are labelled in English
and Traditional Chinese. A matching release tag keeps the actual release version;
local checkout changes add the SHA and modifier, including packaging's version rewrite.
Older packages without a stamp keep their package-version display. An already
cached old Settings panel keeps its old label until reloaded.

Runtime reads only bounded, fixed installed files: it does not run Git, inspect
the current working directory, use an environment override or read a profile.
The stamp is build metadata supplied by the installer, **not a signed attestation**
or evidence that the installed files remain unchanged. It grants no authority.
It does not alter `agend --version`, package SemVer, updater channel/version
comparisons, bundled-Node receipts or the native runtime's separate build ID.

Acceptance uses scratch Git repositories and archives, packed files without
`.git`, the real CLI registration and Hub init composition with inert terminal
and service boundaries, and the real Settings renderer with old/new API data.
Browser checks retain the actual previous shared assets and old panel, in both
languages and desktop/phone layouts. No live Hub, directory, account or pilot
deployment is needed. Rollback removes the additive UI/command/stamp; older code
ignores the stamp and continues to use package SemVer.
