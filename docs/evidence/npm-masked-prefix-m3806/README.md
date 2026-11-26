# M-3806: npm hides a global prefix with a UUID in its path (repro evidence)

`repro.log` is the output of `scripts/manual/npm-masked-prefix-m3806/repro.sh` on Linux x64 (Node 22.22.2), with real npm 10.9.7, 11.21.3 and 12.2.3. The prefix was set the usual way, in the user's `.npmrc`. It used scratch prefixes, a scratch HOME/AGEND_HOME and the registry. The host's global npm, its live install and any fleet were not touched. Scratch paths are shown as `<scratch>`; npm's deprecation warnings are left out.

The candidate is `npm pack` of this branch, versioned `2.4.0-m3806.2` (after Fable's F1/F2) so it can't be mistaken for a release. The published `2.4.0-beta.24` is the "before". `npm_config_allow_scripts=@songsid/agend` is set throughout, so npm 12's install-script rule (M-3805) is not what fails.

| Step | What runs | Result |
|---|---|---|
| 1 | npm 10, 11 and 12 asked for a prefix `…/p-<uuid>` | `npm config get prefix` refuses on all three ("The prefix option is protected", exit 1). npm 11 and 12 print `npm prefix -g` and `npm root -g` as `…/p-***`. A program `npm exec -c` starts gets the real path in `npm_config_global_prefix` on all three. The ask runs from `/`, and an answer is taken only if npm, redacting it, prints exactly what it printed. |
| 2 | the published installer into a UUID prefix, npm 12 and 11 | npm installs, then the installer looks for `…/p-***/bin/agend` and fails: "reports nothing". |
| 3 | the candidate's installer into a UUID prefix, npm 12, 11 and 10 | Installed and verified on all three. |
| 4 | install.sh's prefix/sudo step, prefix `~/.npm-<uuid>` (not created yet), npm 12 and 10 | Before: the refused `npm config get prefix` falls back to `/usr/local`, so the one-liner would pick sudo and install into the wrong prefix. This happens on npm 10 too. After: the real prefix, created, no sudo. |
| 5 | started from inside a project with its own `node_modules/.bin/node`, npm 12 | There, a child of `npm exec` is the project's `node` and answers `/from-project-local-node` (Fable #4526 F2). install.sh's prefix step asks from `/` and gets the real prefix. Out of scope, noted: from such a folder `npm exec … -- agend-install` runs the installer itself on the project's `node`, before any prefix code runs. |

To re-run: `scripts/manual/npm-masked-prefix-m3806/repro.sh <candidate.tgz> <install.sh before> <install.sh after> [scratch dir]`. The scratch dir must not contain a UUID itself.
