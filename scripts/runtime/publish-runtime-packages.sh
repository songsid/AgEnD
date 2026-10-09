#!/usr/bin/env bash
# Publish (or dry-run) every built @songsid/agend-node-* package under <dir> (#1450, publish-runtime.yml).
# Usage: publish-runtime-packages.sh <dir> <true|false: dry run>
# Every publish carries an explicit dist-tag: a repack (x.y.z-agend.N) is a semver prerelease, and npm 11 refuses
# to publish a prerelease without --tag (#1457 review). The tag is `latest` for both: AgEnD pins exact versions, so
# the tag only says which package of this name is current.
# A version already on the registry is skipped, not an error: a run that published some packages and then failed can
# simply be run again (npm versions are immutable, so "already there" is the outcome a re-run wants). A lookup that
# cannot say — anything but the version itself, an empty answer or E404 — stops the run.
# Auth (publish-runtime.yml): npm trusted publishing (OIDC). npm cannot create a NEW package name through OIDC, so the
# first publish of a runtime package uses a short-lived NPM_TOKEN secret as NODE_AUTH_TOKEN (docs/development.md).
set -euo pipefail
DIR="${1:?package directory}"; DRY_RUN="${2:?true|false}"
case "$DRY_RUN" in true|false) ;; *) echo "dry run must be true or false" >&2; exit 2 ;; esac
found=0
ERR="$(mktemp)"; trap 'rm -f "$ERR"' EXIT
for pkg in "$DIR"/*/; do
  [ -f "$pkg/package.json" ] || continue
  found=1
  spec="$(node -p 'const p = require(process.argv[1]); p.name + "@" + p.version' "$pkg/package.json")"
  set +e; seen="$(npm view "$spec" version --json 2>"$ERR")"; vrc=$?; set -e
  if [ "$vrc" -eq 0 ] && [ "$seen" = "\"${spec##*@}\"" ]; then
    echo "$spec: already on the registry, skipped"
    continue
  fi
  if [ "$vrc" -ne 0 ] && ! grep -qE "E404|404 Not Found" "$ERR"; then
    echo "$spec: npm view failed, so whether it is published cannot be told — not publishing anything further:" >&2
    tail -3 "$ERR" >&2
    exit 1
  fi
  (cd "$pkg" && npm pack --dry-run --json | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8"))[0]; console.log(`${p.name}@${p.version}: ${p.size} bytes packed, ${p.unpackedSize} unpacked, ${p.entryCount} files`)')
  if [ "$DRY_RUN" = "true" ]; then
    (cd "$pkg" && npm publish --dry-run --access public --provenance --tag latest)
  else
    (cd "$pkg" && npm publish --access public --provenance --tag latest)
  fi
done
[ "$found" -eq 1 ] || { echo "no packages under $DIR" >&2; exit 1; }
