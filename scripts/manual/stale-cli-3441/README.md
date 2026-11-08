# #3441 fake npm replacement acceptance

This rig runs an **inert C fixture**, not Claude Code, in an owned private tmux server. No account, API key, vendor request, CLI version probe or npm registry install is involved. It exercises the production daemon launch/readiness/repair code, production filesystem worker and actual `/proc` inode evidence. The small control adapter waits for actual pane output. Launcher discovery is confined to the fixture's installed path; ordinary resolver tests cover discovery separately.

Requirements: Linux, Node matching AgEnD's engines, installed repository dependencies, `cc`, tmux. From the repository root, use your current absolute Node path and an owned HOME:

```sh
RIG_HOME=$(mktemp -d /tmp/stale-cli-3441-XXXXXX)
RIG_NODE=$(command -v node)
env -i HOME="$RIG_HOME" PATH="$(dirname "$RIG_NODE"):/usr/bin:/bin" \
  "$RIG_NODE" --import tsx scripts/manual/stale-cli-3441/accept.mts
rm -rf -- "$RIG_HOME"
```

Do not use the host/default tmux socket. The script configures a PID-unique socket before any tmux operation, creates only fixture panes, and closes that server in `finally`. Only owned pane PIDs are checked. `remainingOwnedPids` must be empty. The rig subdirectory is removed; the caller removes the empty owned HOME.

The four cases assert:

- npm renames the package, unlinks the actual running ELF, and temporarily leaves the stable launcher absent. The filesystem worker reads a real `.claude-code-Rig123/.../claude.exe (deleted)` kernel link. The next owned inspection publishes the new stable package, and exactly one repair resumes the retained UUID.
- The production minimum-error dispatch repairs once with a sufficient on-disk package; repeating the old row cannot restart the verified new process.
- The same minimum error with an outdated installed package posts one update notice and starts no replacement.
- A second replaced image after the one repair posts one terminal runtime notice, blocks delivery and grants no further repair.

All processes are fixture ELFs. The minimum-error text is intentionally injected into the production dispatch; no claim about a real signed-in Claude/model or the unidentified field updater is made. Unit tests separately cover native version-named installs, JS metadata ambiguity, ownership changes, PID reuse, queued delivery and the exact tmux mutation fence.
