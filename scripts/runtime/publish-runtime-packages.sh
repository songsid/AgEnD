#!/usr/bin/env bash
# Publish (or dry-run) every built @songsid/agend-node-* package under <dir> (#1450, publish-runtime.yml).
# Usage: publish-runtime-packages.sh <dir> <true|false: dry run>
# Every publish carries an explicit dist-tag: a repack (x.y.z-agend.N) is a semver prerelease, and npm 11 refuses
# to publish a prerelease without --tag (#1457 review). The tag is `latest` for both: AgEnD pins exact versions, so
# the tag only says which package of this name is current.
set -euo pipefail
DIR="${1:?package directory}"; DRY_RUN="${2:?true|false}"
case "$DRY_RUN" in true|false) ;; *) echo "dry run must be true or false" >&2; exit 2 ;; esac
found=0
for pkg in "$DIR"/*/; do
  [ -f "$pkg/package.json" ] || continue
  found=1
  (cd "$pkg" && npm pack --dry-run --json | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8"))[0]; console.log(`${p.name}@${p.version}: ${p.size} bytes packed, ${p.unpackedSize} unpacked, ${p.entryCount} files`)')
  if [ "$DRY_RUN" = "true" ]; then
    (cd "$pkg" && npm publish --dry-run --access public --provenance --tag latest)
  else
    (cd "$pkg" && npm publish --access public --provenance --tag latest)
  fi
done
[ "$found" -eq 1 ] || { echo "no packages under $DIR" >&2; exit 1; }
