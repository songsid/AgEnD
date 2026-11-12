#!/usr/bin/env bash
# No GitHub commit-list API: every reachable PR commit is in the scan range.
set -euo pipefail
fail() { echo "Gitleaks PR scan refused: $*" >&2; exit 1; }
for name in PR_BASE_SHA PR_HEAD_SHA; do
  value="${!name:-}"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || fail "$name is missing or is not a full commit SHA"
  git cat-file -e "${value}^{commit}" || fail "$name is not available as a commit"
done
[[ "$(git rev-parse --is-shallow-repository)" == false ]] || fail "complete history is required"
# An ambiguous criss-cross merge base must not silently choose a partial range.
bases="$(git merge-base --all "$PR_BASE_SHA" "$PR_HEAD_SHA")" || fail "merge base is unknown"
[[ "$bases" =~ ^[0-9a-f]{40}$ ]] || fail "merge base is missing or ambiguous"
[[ -f .gitleaks.toml && -f .gitleaksignore ]] || fail "scan configuration or fingerprint ignore file is missing"
[[ "$(gitleaks version)" == 8.24.3 ]] || fail "expected pinned Gitleaks 8.24.3"
range="$bases..$PR_HEAD_SHA"
echo "Gitleaks PR range: $range ($(git rev-list --count "$range") commits)"
# Traverse side histories too; show only changes beyond Git’s automatic remerge.
# --diff-merges changes diffs, unlike --first-parent which drops side commits.
# Git >=2.36 and writable objects are required; Git/scanner errors must fail.
exec gitleaks detect --redact --exit-code=2 \
  --config=.gitleaks.toml --gitleaks-ignore-path=.gitleaksignore \
  --report-format=sarif --report-path=results.sarif \
  "--log-opts=--diff-merges=remerge $range"
