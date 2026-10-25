#!/usr/bin/env bash
# Classify a PR diff for CI path gating. Writes GitHub Actions outputs:
#   docs-only   — every path is a changelog fragment (legacy fast path name)
#   text-only   — only docs/**, changes/**, root *.md, website/src/content/**
#   packaging   — package/lock, launcher/, install/update/service code,
#                 scripts/**, .github/**
#   deps        — package.json or a lockfile (root or website/), .github/**
#   src         — src/**, scripts/**, .github/**
#
# A change to a gated job's own workflow, action or scripts must turn that
# job on: .github/** runs the full suite; scripts/** sets src and packaging.
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

docs_only=false
text_only=false
packaging=false
deps=false
src=false

# Legacy: only assembler fragments skip the old "docs-only" name.
if ! grep -qvE '^changes/[0-9]+(-[a-z0-9][a-z0-9-]*)?(\.zh-TW)?\.md$' "$_diff_f"; then
  docs_only=true
fi

# text-only allowlist. Any other path (src/, tests/, scripts/, workflows,
# package, lockfile, locale, …) means it is not text-only.
if ! grep -qvE '^(docs/|changes/|website/src/content/|[^/]+\.md$)' "$_diff_f"; then
  text_only=true
fi

if grep -qE '^src/' "$_diff_f"; then
  src=true
fi

if grep -qE '^(website/)?package(-lock)?\.json$' "$_diff_f"; then
  deps=true
  packaging=true
fi

if grep -qE '^install\.sh$|^launcher/|^templates/|^website/public/install\.sh$|^scripts/preinstall-guard\.cjs$|^scripts/ci/(install-published-tarball|npm-rollback-proof|verify-published-tarball)\.|^src/(completion-install|install-lock|launchd-handoff|service-|update-|updater-caller)|^\.github/actions/published-agend-tarball/' "$_diff_f"; then
  packaging=true
fi

# Scripts the gated jobs run: data-downgrade, install-smoke, signatures.
if grep -qE '^scripts/' "$_diff_f"; then
  text_only=false
  packaging=true
  src=true
fi
if grep -qE '^scripts/ci/audit-signatures' "$_diff_f"; then
  deps=true
fi

# A change to a gated job's own workflow or action must run every gated job.
if grep -qE '^\.github/' "$_diff_f"; then
  text_only=false
  packaging=true
  deps=true
  src=true
fi

emit docs-only "$docs_only"
emit text-only "$text_only"
emit packaging "$packaging"
emit deps "$deps"
emit src "$src"
