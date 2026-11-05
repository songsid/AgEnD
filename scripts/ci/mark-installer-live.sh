#!/usr/bin/env bash
# The tag `installer-live` names the commit GitHub Pages last deployed from main, so
# raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public/... serves exactly the deployed installer — the
# fallback when a network blocks *.github.io (deploy-website.yml).
#   mark-installer-live.sh --check <sha>   admission, BEFORE Pages is touched: <sha> must contain the current tag
#   mark-installer-live.sh <sha>           after the deploy: move the tag to <sha>
# Forward only, and atomic: the remote tag is read with ls-remote (an unreadable remote fails closed; only a remote that
# answers without the tag counts as "absent"), and the push is a compare-and-set lease on exactly what was read, so a
# writer that moved it in between makes this push fail instead of being overwritten. Needs full history.
set -euo pipefail
mode=move
if [ "${1:-}" = --check ]; then mode=check; shift; fi
sha=${1:-}
tag=installer-live
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "mark-installer-live: expected a full commit SHA, got '$sha'" >&2; exit 2; }
git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "mark-installer-live: $sha is not a commit here (fetch full history)" >&2; exit 2; }
if ! listed=$(git ls-remote --tags origin "refs/tags/$tag"); then
  echo "mark-installer-live: could not read origin's $tag; refusing to guess" >&2; exit 3
fi
current=$(printf '%s\n' "$listed" | awk -v r="refs/tags/$tag" '$2 == r { print $1 }')
if [ -n "$current" ]; then
  if ! git cat-file -e "$current^{commit}" 2>/dev/null; then
    git fetch --quiet origin "$current" 2>/dev/null || { echo "mark-installer-live: could not fetch $current (origin's $tag)" >&2; exit 3; }
  fi
  if [ "$current" != "$sha" ] && ! git merge-base --is-ancestor "$current" "$sha"; then
    echo "mark-installer-live: refusing to move $tag from $current to $sha, which does not contain it" >&2
    exit 1
  fi
fi
if [ "$mode" = check ]; then echo "$tag: $sha may be deployed (it contains ${current:-no tag yet})"; exit 0; fi
if [ "$current" = "$sha" ]; then echo "$tag is already at $sha"; exit 0; fi
if [ -n "${MARK_INSTALLER_LIVE_BEFORE_PUSH:-}" ]; then eval "$MARK_INSTALLER_LIVE_BEFORE_PUSH"; fi   # test seam: a racing writer
git push --force-with-lease="refs/tags/$tag:$current" origin "$sha:refs/tags/$tag"
echo "$tag -> $sha"
