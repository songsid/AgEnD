# M-3812: the installer launch runs a project's own node (repro evidence)

`repro.log` is the output of `scripts/manual/installer-neutral-cwd-m3812/repro.sh` on Linux x64 (Node 22.22.2), with real npm 10.9.7 and 12.2.3. It used scratch prefixes (set in the user's `.npmrc`), a scratch HOME/AGEND_HOME and the registry. The host's global npm, its live install and any fleet were not touched. Scratch paths are shown as `<scratch>`; npm's deprecation warnings are left out.

The folder everything is started from is a project with its own `node_modules/.bin/node`, a shim that only prints that it ran. The npm package `node` installs exactly such a file. The installer is the published `2.4.0-beta.24`'s: what changed is how it is launched.

| Step | What runs | Result |
|---|---|---|
| 1 | npm 12, inside the project: `npm exec --package @songsid/agend@2.4.0-beta.24 -- agend-install` | The project's `node` runs the installer's file: npm exec puts the folder's `node_modules/.bin` first on PATH. Nothing is installed. |
| 2 | install.sh's installer step, started inside the project, npm 12 and 10 | Before: the project's `node` runs. The step then "finishes" with exit 0 and nothing installed. After: the step launches the installer from `/`, and it installs and verifies `2.4.0-beta.24` on both npm versions. |

`agend update` makes the same launch (`npm exec … -- agend-install --upgrade`). It now passes the filesystem root as `cwd`. tests/update-detached-1631.test.ts runs it through the built CLI from such a project, with an npm stub that puts the folder's `.bin` first as npm does.

To re-run: `scripts/manual/installer-neutral-cwd-m3812/repro.sh <install.sh before> <install.sh after> [scratch dir]`.
