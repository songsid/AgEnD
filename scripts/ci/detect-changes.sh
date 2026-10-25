#!/usr/bin/env bash
# Classify a PR diff for CI path gating. Writes GitHub Actions outputs:
#   docs-only   — every path is a changelog fragment (legacy fast path name)
#   text-only   — only docs/**, changes/**, root *.md, website/src/content/**
#   packaging   — package/lock, launcher/, install/update/service code
#   deps        — package.json or a lockfile (root or website/)
#   src         — any src/** path
#
# Fail closed: unreadable or empty diffs, and every non-pull_request event,
# emit text-only=false and packaging/deps/src=true so the full suite runs.
# Never pipe git into grep (SIGPIPE + pipefail used to fail-open).
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

emit() {
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}

full_suite() {
  emit docs-only false
  emit text-only false
  emit packaging true
  emit deps true
  emit src true
  exit 0
}

EVENT_NAME="${EVENT_NAME:-}"
if [ "$EVENT_NAME" != "pull_request" ]; then
  full_suite
fi

if ! diff_files=$(git diff --name-only "${BASE_SHA:-}...${HEAD_SHA:-}"); then
  full_suite
fi

_diff_f=$(mktemp)
trap 'rm -f "$_diff_f"' EXIT
printf '%s\n' "$diff_files" | grep -v '^$' > "$_diff_f" || true
if [ ! -s "$_diff_f" ]; then
  full_suite
fi

# Legacy: only assembler fragments skip the old "docs-only" name.
if grep -qvE '^changes/[0-9]+(-[a-z0-9][a-z0-9-]*)?(\.zh-TW)?\.md$' "$_diff_f"; then
  emit docs-only false
else
  emit docs-only true
fi

# text-only allowlist. Any other path (src/, tests/, scripts/, workflows,
# package, lockfile, locale, …) means it is not text-only.
if grep -qvE '^(docs/|changes/|website/src/content/|[^/]+\.md$)' "$_diff_f"; then
  emit text-only false
else
  emit text-only true
fi

if grep -qE '^src/' "$_diff_f"; then
  emit src true
else
  emit src false
fi

if grep -qE '^(website/)?package(-lock)?\.json$' "$_diff_f"; then
  emit deps true
else
  emit deps false
fi

if grep -qE '^(website/)?package(-lock)?\.json$|^install\.sh$|^launcher/|^templates/|^website/public/install\.sh$|^scripts/preinstall-guard\.cjs$|^scripts/ci/(install-published-tarball|npm-rollback-proof|verify-published-tarball)\.|^src/(completion-install|install-lock|launchd-handoff|service-|update-|updater-caller)|^\.github/actions/published-agend-tarball/' "$_diff_f"; then
  emit packaging true
else
  emit packaging false
fi
