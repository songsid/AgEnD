# M-3805: npm 12 and AgEnD's install scripts (repro evidence)

`repro.log` is the output of `scripts/manual/npm12-allow-scripts-m3805/repro.sh` on Linux x64 (Node 22.22.2), with real npm 10.9.7, 11.21.3 and 12.2.3. It used scratch prefixes, a scratch HOME/AGEND_HOME and the registry. The host's global npm, its live install and any fleet were not touched. Scratch paths are shown as `<scratch>`.

The candidate is `npm pack` of this branch, built from `ed1755b17` and versioned `2.4.0-m3805.1` so it can't be mistaken for a release. The script took it as its argument. The published `2.4.0-beta.24` is the "before".

| Step | What runs | Result |
|---|---|---|
| 1 | npm 12, plain `npm install -g @songsid/agend@2.4.0-beta.24` | Install scripts are blocked. `agend --version` refuses with "missing, incomplete or changed", and its repair line fails the same way (the user's report). |
| 2 | npm 12, plain install of the candidate | Still blocked (a plain install is the person's command). The launcher now says the install step did not run and prints `npm install -g --allow-scripts=@songsid/agend …`. With no node on PATH, the sh bin says the same. |
| 3 | the printed repair, on npm 12, over step 1's broken install | Works. |
| 4 | the candidate's own installer (`agend update`, the Hub update and install.sh run it) on npm 12, 11 and 10, with no allow setting anywhere | Installed and verified on all three. |
| 4b | the published beta.24 installer on npm 12 | Without the variable it fails like step 1. With `npm_config_allow_scripts=@songsid/agend`, which this branch's `agend update` and install.sh set, it installs. |
| 5 | `npm exec` on npm 10, 11 and 12 | Only the variable reaches the program `npm exec` starts. The flag does not on npm 11 and 12, which is why the variable is used. |
| 6 | npm 12 with `--ignore-scripts --allow-scripts=…` | Still blocked: ignore-scripts wins, so the update pre-flight stops on it (P7 `scripts-off`). |

A scratch path that contains a UUID breaks step 4 on npm 11 and 12. Their output redacts UUID-like text, so `npm prefix -g` prints `***` and the installer looks in a folder that doesn't exist. That's why the rig runs under `~/.cache/rh-m3805`. It is unrelated to npm 12's install scripts, but noted: the installer trusts `npm prefix -g` output.
