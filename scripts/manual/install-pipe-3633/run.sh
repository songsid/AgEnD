#!/usr/bin/env bash
# Real package-manager rehearsal. Never privileged; only owned containers and a read-only evidence mount.
set -euo pipefail
REPO=$(git rev-parse --show-toplevel)
RIG_DIR=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$(mktemp -d "$REPO/.artifacts/install-pipe-3633.XXXXXX")}
mkdir -p "$OUT"
BASE=${BASE:-43e5708356d6b31cb596a719079f7dc945d8eed3}
IMAGE="agend-install3633-$(id -u)-$$"
containers=()
cleanup() { for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
cp "$RIG_DIR/serve.cjs" "$RIG_DIR/run-leg.sh" "$OUT/"
git -C "$REPO" show "$BASE:install.sh" > "$OUT/baseline.sh"
cp "$REPO/install.sh" "$OUT/fixed.sh"
docker build -t "$IMAGE" "$RIG_DIR" > "$OUT/build.log" 2>&1
for LEG in baseline fixed; do
  name="$IMAGE-$LEG"; containers+=("$name")
  docker run --name "$name" --memory 2g -e "LEG=$LEG" -e AGEND_VERSION=2.3.4 -e AGEND_NO_COMPLETION=1 \
    -v "$OUT:/evidence:ro" "$IMAGE" bash /evidence/run-leg.sh > "$OUT/$LEG.log" 2>&1
  if [ "$LEG" = baseline ]; then
    grep -q 'Geographic area:' "$OUT/$LEG.log"
    grep -q 'PIPELINE_EXIT=0' "$OUT/$LEG.log"
    grep -q 'VERSION_EXIT=127' "$OUT/$LEG.log"
  else
    ! grep -q 'Geographic area:' "$OUT/$LEG.log"
    grep -q 'Installation Complete' "$OUT/$LEG.log"
    grep -q 'VERSION_EXIT=0' "$OUT/$LEG.log"
  fi
done
printf 'PASS: baseline consumes script; fixed installs and runs from PATH. Logs: %s\n' "$OUT"
