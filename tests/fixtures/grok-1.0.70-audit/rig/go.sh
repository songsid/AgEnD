#!/bin/bash
# One container per run: network none, uid 1000, binaries read-only, private tmux inside.
G=$(dirname "$0"); V=$1; shift
docker run --rm --network none --user 1000 \
  -v "$G/bin/grok-$V:/bin/grok-$V:ro" -v "$G/rig:/rig:ro" -v "$G/out:/out" \
  grok-audit-160 bash -c "$*" > "$G/out/log-$V-$(echo "$*" | tr -c 'a-z0-9' '_' | cut -c1-40).txt" 2>&1
echo "$V $* exit=$?"
