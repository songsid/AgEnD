#!/usr/bin/env bash
# #1819: CI installs a PUBLISHED @songsid/agend (the 2.1.12 baseline) from one cached tarball instead of fetching it from
# the registry on every run, where each fetch counts as an npm download. Before any install, the tarball must be exactly
# what the registry published: its sha512 equals the registry's dist.integrity for that version (`npm view`, a metadata
# request, not a download). Anything else fails closed: an unreadable integrity, an empty one, a mismatch. A stale or
# tampered cache is never installed and nothing re-fetches around it.
# Usage: verify-published-tarball.sh <tarball> <package> <version>
set -euo pipefail
TGZ="${1:?tarball}"; PKG="${2:?package}"; VERSION="${3:?version}"
fail() { echo "::error::$*" >&2; exit 1; }
[ -f "$TGZ" ] || fail "no tarball at $TGZ"
want="$(npm view "$PKG@$VERSION" dist.integrity --registry https://registry.npmjs.org/)" \
  || fail "could not read the registry's dist.integrity for $PKG@$VERSION"
case "$want" in sha512-?*) ;; *) fail "the registry gave no sha512 integrity for $PKG@$VERSION (got '$want')" ;; esac
got="sha512-$(node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$TGZ")"
[ "$got" = "$want" ] || fail "$TGZ is not the published $PKG@$VERSION: its sha512 is $got, the registry's dist.integrity is $want"
echo "verified: $TGZ is the published $PKG@$VERSION ($want)"
