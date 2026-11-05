#!/usr/bin/env bash
# Move the tag `installer-live` to the commit Pages just deployed (deploy-website.yml, job mark-live), so
# raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public/... serves exactly the deployed installer — the
# fallback when a network blocks *.github.io. Forward only: a commit that does not contain the current tag is refused,
# so an older run finishing late can never move it back. Run in a checkout with full history and push access to origin.
#   mark-installer-live.sh <40-hex sha>
set -euo pipefail
sha=${1:-}
tag=installer-live
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "mark-installer-live: expected a full commit SHA, got '$sha'" >&2; exit 2; }
git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "mark-installer-live: $sha is not a commit here (fetch full history)" >&2; exit 2; }
# The tag as origin has it now (absent on the first deploy).
git fetch --quiet --force origin "+refs/tags/$tag:refs/tags/$tag" 2>/dev/null || true
if current=$(git rev-parse --quiet --verify "refs/tags/$tag^{commit}"); then
  if [ "$current" = "$sha" ]; then echo "$tag is already at $sha"; exit 0; fi
  if ! git merge-base --is-ancestor "$current" "$sha"; then
    echo "mark-installer-live: refusing to move $tag from $current to $sha, which does not contain it" >&2
    exit 1
  fi
fi
git tag --force "$tag" "$sha" >/dev/null
git push --force origin "refs/tags/$tag"
echo "$tag -> $sha"
