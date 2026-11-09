#!/usr/bin/env bash
# The BRANCH `installer-live` names the commit GitHub Pages last deployed from main, so
# raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public/... serves exactly the deployed installer — the
# fallback when a network blocks *.github.io (deploy-website.yml). A branch, not a tag: a moving tag breaks
# `git fetch --tags` in every clone holding an older copy ("would clobber existing tag"); moving refs are branches.
#   mark-installer-live.sh --check <sha>   admission, BEFORE Pages is touched: <sha> must contain the current branch
#   mark-installer-live.sh <sha>           after the deploy: move the branch to <sha>
# Forward only, and atomic: the remote ref is read with ls-remote (an unreadable remote fails closed; only a remote that
# answers without the branch counts as "absent"), and the push is a compare-and-set lease on exactly what was read, so a
# writer that moved it in between makes this push fail instead of being overwritten. Needs full history.
# While a TAG of the same name still exists (the one-time cutover from the old tag is unfinished), both modes refuse:
# raw.githubusercontent.com could resolve either ref, so nothing deploys until the tag is gone (see the PR's cutover).
set -euo pipefail
mode=move
if [ "${1:-}" = --check ]; then mode=check; shift; fi
sha=${1:-}
name=installer-live
ref=refs/heads/$name
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "mark-installer-live: expected a full commit SHA, got '$sha'" >&2; exit 2; }
git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "mark-installer-live: $sha is not a commit here (fetch full history)" >&2; exit 2; }
if ! listed=$(git ls-remote origin "$ref" "refs/tags/$name"); then
  echo "mark-installer-live: could not read origin's $name; refusing to guess" >&2; exit 3
fi
if printf '%s\n' "$listed" | awk -v r="refs/tags/$name" '$2 == r { found = 1 } END { exit !found }'; then
  echo "mark-installer-live: origin still has the old TAG $name; delete it first (the one-time cutover), so the raw URL names one ref" >&2
  exit 4
fi
current=$(printf '%s\n' "$listed" | awk -v r="$ref" '$2 == r { print $1 }')
if [ -n "$current" ]; then
  if ! git cat-file -e "$current^{commit}" 2>/dev/null; then
    git fetch --quiet origin "$current" 2>/dev/null || { echo "mark-installer-live: could not fetch $current (origin's $name)" >&2; exit 3; }
  fi
  if [ "$current" != "$sha" ] && ! git merge-base --is-ancestor "$current" "$sha"; then
    echo "mark-installer-live: refusing to move $name from $current to $sha, which does not contain it" >&2
    exit 1
  fi
fi
if [ "$mode" = check ]; then echo "$name: $sha may be deployed (it contains ${current:-no branch yet})"; exit 0; fi
if [ "$current" = "$sha" ]; then echo "$name is already at $sha"; exit 0; fi
if [ -n "${MARK_INSTALLER_LIVE_BEFORE_PUSH:-}" ]; then eval "$MARK_INSTALLER_LIVE_BEFORE_PUSH"; fi   # test seam: a racing writer
git push --force-with-lease="$ref:$current" origin "$sha:$ref"
echo "$name -> $sha"
