#!/bin/bash
# M-2457 §2 matrix: the leak and #735-stress legs for one tmux build, in a throwaway container with no network.
# Only private sockets inside that container; nothing on the host is touched.
#   scripts/manual/tmux-matrix/container-legs.sh <bundle dir holding bin/tmux> [leak|stress|all]
#   LEAK_SECONDS=180 STRESS_SECONDS=600 STRESS_WINDOWS=24 IMAGE=python:3.12-slim (any image with bash, python3, awk)
# Linux bundles only (the image runs the static binary). Record the printed RSS lines in the design note's matrix.
set -euo pipefail
BUNDLE=$(cd "${1:?bundle dir}" && pwd); LEG=${2:-all}
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-python:3.12-slim}
docker run --rm --network none --memory=4g --cap-drop=ALL --security-opt no-new-privileges \
  -v "$BUNDLE:/opt/t:ro" -v "$HERE:/m:ro" \
  -e LEG="$LEG" -e N_LEAK="${LEAK_SECONDS:-180}" -e N_STRESS="${STRESS_SECONDS:-600}" -e W="${STRESS_WINDOWS:-24}" \
  --entrypoint bash "$IMAGE" -c '
    export PATH=/opt/t/bin:$PATH TERMINFO_DIRS=/opt/t/share/terminfo LANG=C.UTF-8
    echo "== $(tmux -V)"
    if [ "$LEG" = leak ] || [ "$LEG" = all ]; then
      for via in control cli; do
        SOCKET=leak-$via VIA=$via PANE=redraw N=$N_LEAK bash /m/leak-repro.sh 2>&1 | sed "s/^/[leak $via] /"
        tmux -L leak-$via kill-server 2>/dev/null || true   # the repro'"'"'s EXIT trap does not run when backgrounded
      done
    fi
    if [ "$LEG" = stress ] || [ "$LEG" = all ]; then N=$N_STRESS W=$W bash /m/stress-735.sh; fi'
