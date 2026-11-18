#!/bin/bash
# Run from an isolated worktree. Three binaries supplied by the operator; no installs/accounts.
set -euo pipefail
: "${CLAUDE_295:?path to the retained 2.1.295 Linux binary}"
: "${CLAUDE_327:?path to the retained 2.1.327 Linux binary}"
: "${CLAUDE_294:?path to the retained 2.1.294 negative-control binary}"
: "${GUARD_RIG_OUTPUT:?fresh owned output directory}"
rig_repo="$(cd "$(dirname "$0")/../../.." && pwd)"
rig_node="$(realpath "$(command -v node)")"
rig_modules="$(realpath "$rig_repo/node_modules")"
mkdir -p "$GUARD_RIG_OUTPUT/home"
rig_output="$(realpath "$GUARD_RIG_OUTPUT")"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$rig_output/server.key" -out "$rig_output/server.crt" \
  -subj '/CN=guard-fixture' -addext 'subjectAltName=DNS:api.anthropic.com,DNS:claude.ai,DNS:example.com' > "$rig_output/cert.log" 2>&1
bwrap --unshare-all --die-with-parent \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /etc \
  --ro-bind "$rig_repo" /repo --ro-bind "$rig_modules" /node_modules --ro-bind "$rig_node" /audit-node \
  --ro-bind "$(realpath "$CLAUDE_295")" /versions/2.1.295 \
  --ro-bind "$(realpath "$CLAUDE_327")" /versions/2.1.327 \
  --ro-bind "$(realpath "$CLAUDE_294")" /versions/2.1.294 \
  --bind "$rig_output" /rig --clearenv --setenv HOME /rig/home --setenv PATH /usr/bin:/bin \
  --setenv LANG C.UTF-8 --setenv TERM dumb --chdir /repo \
  --setenv GUARD_RIG_CASE "${GUARD_RIG_CASE:-}" \
  --setenv GUARD_RIG_VERSIONS "${GUARD_RIG_VERSIONS:-}" \
  /audit-node /node_modules/tsx/dist/cli.mjs /repo/scripts/manual/classic-cli-guard/rig.mts
