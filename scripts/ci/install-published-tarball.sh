#!/usr/bin/env bash
# #1819: install a published package from its verified tarball (verify-published-tarball.sh) with `npm install --global`,
# and prove the install fetched no tarball of that package from any registry: that would be a counted npm download.
# Dependencies still come from the registry; they are not our download count. npm's http log is the evidence: every
# request it made is counted, and one for `<package>/-/…` (a tarball of the package) fails the step.
# Usage: install-published-tarball.sh <package> <tarball> [npm install args…]
#   (prefix, registry and cache come from the args or npm_config_*)
set -euo pipefail
PKG="${1:?package}"; TGZ="${2:?tarball}"; shift 2
fail() { echo "::error::$*" >&2; exit 1; }
[ -f "$TGZ" ] || fail "no tarball at $TGZ"
case "$PKG" in */*) tarballs="/${PKG%%/*}(/|%2[fF])${PKG#*/}/-/" ;; *) tarballs="/$PKG/-/" ;; esac
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
set +e
npm install --global --no-audit --no-fund --loglevel=http "$@" "$TGZ" >"$LOG" 2>&1
rc=$?
set -e
grep -v '^npm http fetch ' "$LOG" || true
[ "$rc" = 0 ] || fail "npm install of $TGZ exited $rc"
fetched="$(grep -c '^npm http fetch ' "$LOG" || true)"
ours="$(grep -E "^npm http fetch .*$tarballs" "$LOG" || true)"
[ -z "$ours" ] || { echo "$ours" >&2; fail "installing $TGZ downloaded a $PKG tarball from a registry"; }
echo "installed $PKG from $TGZ: $fetched registry requests (dependencies), none for a $PKG tarball"
