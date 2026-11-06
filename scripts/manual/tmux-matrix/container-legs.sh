#!/bin/bash
# M-2457 §2 matrix: the leak and #735-stress legs for one tmux build, in a throwaway container with no network.
# Only private sockets inside that container; nothing on the host is touched.
#   scripts/manual/tmux-matrix/container-legs.sh <bundle dir holding bin/tmux> [leak|stress|all]
#   LEAK_SECONDS=180 LEAK_SAMPLE_EVERY=30 STRESS_SECONDS=600 STRESS_WINDOWS=24 IMAGE=python:3.12-slim (any image with bash, python3, awk)
# Linux bundles only (the image runs the static binary). Exits non-zero if any leg failed to measure what it claims.
# Prints the tested binary's sha256 first: record it with the results in the design note's matrix.
set -euo pipefail
BUNDLE=$(cd "${1:?bundle dir}" && pwd); LEG=${2:-all}
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-python:3.12-slim}
case "$LEG" in leak|stress|all) ;; *) echo "leg must be leak, stress or all" >&2; exit 2 ;; esac
echo "== bundle $BUNDLE/bin/tmux sha256 $(sha256sum "$BUNDLE/bin/tmux" | cut -d" " -f1)"
docker run --rm --network none --memory=4g --cap-drop=ALL --security-opt no-new-privileges \
  -v "$BUNDLE:/opt/t:ro" -v "$HERE:/m:ro" \
  -e LEG="$LEG" -e N_LEAK="${LEAK_SECONDS:-180}" -e EVERY="${LEAK_SAMPLE_EVERY:-30}" -e N_STRESS="${STRESS_SECONDS:-600}" -e W="${STRESS_WINDOWS:-24}" \
  --entrypoint bash "$IMAGE" -c '
    set -uo pipefail
    export PATH=/opt/t/bin:$PATH TERMINFO_DIRS=/opt/t/share/terminfo LANG=C.UTF-8
    echo "== $(tmux -V)"
    failed=0
    if [ "$LEG" = leak ] || [ "$LEG" = all ]; then
      for via in control cli; do
        SOCKET=leak-$via VIA=$via PANE=redraw N=$N_LEAK SAMPLE_EVERY=$EVERY bash /m/leak-repro.sh 2>&1 | sed "s/^/[leak $via] /"
        [ "${PIPESTATUS[0]}" = 0 ] || { echo "[leak $via] FAILED"; failed=1; }
      done
    fi
    if [ "$LEG" = stress ] || [ "$LEG" = all ]; then N=$N_STRESS W=$W bash /m/stress-735.sh || { echo "[stress] FAILED"; failed=1; }; fi
    exit $failed'
