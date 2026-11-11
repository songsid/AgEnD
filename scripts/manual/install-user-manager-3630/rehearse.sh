#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${OUT:-"$REPO/.artifacts/install-user-manager-3630/container"}
BASE=${BASE:-agend-rh-b16-bus:latest}
CONTROL_REF=${CONTROL_REF:-cf7f4b88945c7f2c70036874f907bf4da690a9fb}
NAME=agend-cairn-install-3630
mkdir -p "$OUT/before"
# The existing safety guard masks binfmt and permits only a private cgroup namespace; never privileged or host network.
source "$REPO/scripts/manual/lib/systemd-container.sh"
docker image inspect "$BASE" --format '{{.Id}}' > "$OUT/base-image.txt"
docker tag "$BASE" agend-cairn-install-3630:base
IMAGE=$(systemd_container_image agend-cairn-install-3630:base)
systemd_container_guard "$IMAGE"
git -C "$REPO" archive "$CONTROL_REF" src templates package.json launcher | tar -x -C "$OUT/before"
ln -sfn "$(realpath "$REPO/node_modules")" "$OUT/before/node_modules"
readlink /proc/self/ns/net > "$OUT/host-netns-before.txt"
ls /proc/sys/fs/binfmt_misc > "$OUT/binfmt-before.txt"
CID=''
cleanup(){ if [ -n "$CID" ]; then docker rm --force "$CID" >/dev/null; fi; }
trap cleanup EXIT
CID=$(docker run -d --name "$NAME" --network none "${SYSTEMD_CONTAINER_FLAGS[@]}" \
 --mount "type=bind,source=$REPO,target=/candidate,readonly" \
 --mount "type=bind,source=$OUT/before,target=/before,readonly" \
 --mount "type=bind,source=$(realpath "$REPO/node_modules"),target=$(realpath "$REPO/node_modules"),readonly" "$IMAGE")
docker inspect "$CID" --format '{{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} {{.HostConfig.CgroupnsMode}}' > "$OUT/isolation.txt"
test "$(cat "$OUT/isolation.txt")" = 'false none private'
for n in $(seq 1 40); do if docker exec "$CID" systemctl is-active systemd-logind >/dev/null 2>&1; then break; fi; sleep 0.25; done
docker exec "$CID" readlink /proc/self/ns/net > "$OUT/container-netns.txt"
! cmp -s "$OUT/host-netns-before.txt" "$OUT/container-netns.txt"
docker exec -i "$CID" /bin/bash -s < "$REPO/scripts/manual/install-user-manager-3630/inside.sh" > "$OUT/journey.log" 2>&1
readlink /proc/self/ns/net > "$OUT/host-netns-after.txt"
ls /proc/sys/fs/binfmt_misc > "$OUT/binfmt-after.txt"
cmp "$OUT/host-netns-before.txt" "$OUT/host-netns-after.txt"
cmp "$OUT/binfmt-before.txt" "$OUT/binfmt-after.txt"
cat "$OUT/journey.log"
printf 'PASS: private non-privileged container; host netns/binfmt unchanged; container cleanup owned by trap.\n'
