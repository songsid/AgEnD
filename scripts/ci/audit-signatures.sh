#!/usr/bin/env bash
# Verify npm registry signatures in one install tree (#2528).
# Invalid signatures fail. Missing signatures are printed and do not fail.
# Usage: audit-signatures.sh <dir>
set -euo pipefail
DIR="${1:?directory}"
cd "$DIR"
if ! out="$(npm audit signatures 2>&1)"; then
  printf '%s\n' "$out"
  echo "invalid or failed registry signatures in $DIR" >&2
  exit 1
fi
printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -qi 'missing'; then
  echo "missing signatures reported in $DIR (reported, not a failure)" >&2
fi
