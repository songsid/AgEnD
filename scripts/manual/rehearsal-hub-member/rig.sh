#!/bin/bash
# rig.sh — host side of the Hub + member-fleet rehearsal kit (see README.md). Linux + Docker; never --privileged.
#   rig.sh image                       build the rig image ($RIG-img)
#   rig.sh registry                    a private verdaccio ($RIG-registry on $RIG-net; host 127.0.0.1:$REG_PORT), a publish user
#   rig.sh publish <tgz> <dist-tag>    publish a tarball to that registry only
#   rig.sh start <container> <port>    a systemd container on $RIG-net; the dashboard proxy on 127.0.0.1:<port>; this kit copied to /opt/rh
#   rig.sh run <container> <phase> [args]   hub-member.sh inside it (setup <version> | pair | status | revoke | restart-member | …)
# env: RIG (name prefix, default agend-rhkit), REG_PORT (default 4890), STATE (default ~/.cache/$RIG; the registry + npmrc live here)
set -eu
K=$(cd "$(dirname "$0")" && pwd); RIG=${RIG:-agend-rhkit}; REG_PORT=${REG_PORT:-4890}; STATE=${STATE:-$HOME/.cache/$RIG}
# The ONLY docker run flags a systemd rig container uses (no --privileged, no binfmt_misc mount).
SAFE_RUN="--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined --cgroupns=private --tmpfs /run --tmpfs /run/lock"
R=http://127.0.0.1:$REG_PORT/; mkdir -p "$STATE"
case "${1:-}" in
  image) docker build -q -t $RIG-img "$K/image" ;;
  registry)
    docker rm -f $RIG-registry >/dev/null 2>&1 || true
    docker network inspect $RIG-net >/dev/null 2>&1 || docker network create $RIG-net >/dev/null
    rm -rf "$STATE/registry"; mkdir -p "$STATE/registry/storage" "$STATE/registry/conf"; cp "$K/verdaccio.yaml" "$STATE/registry/conf/config.yaml"; chmod -R a+rwX "$STATE/registry"
    docker run -d --name $RIG-registry --network $RIG-net --network-alias registry -p 127.0.0.1:$REG_PORT:4873 \
      -v "$STATE/registry/conf":/verdaccio/conf -v "$STATE/registry/storage":/verdaccio/storage verdaccio/verdaccio:5 >/dev/null
    for i in $(seq 1 30); do curl -s -o /dev/null ${R}-/ping && break; sleep 1; done
    TOKEN=$(curl -s -X PUT -H 'Content-Type: application/json' -d '{"name":"rehearsal","password":"rehearsal-only"}' ${R}-/user/org.couchdb.user:rehearsal | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
    printf '//127.0.0.1:%s/:_authToken=%s\nregistry=%s\n' "$REG_PORT" "$TOKEN" "$R" > "$STATE/npmrc-publish"; chmod 600 "$STATE/npmrc-publish"
    echo "registry up on $R" ;;
  publish)
    npm publish "$2" --tag "$3" --registry $R --userconfig "$STATE/npmrc-publish" --ignore-scripts >/dev/null && echo "published $(basename "$2") as $3" ;;
  start)
    C=$2; P=$3; docker rm -f $C >/dev/null 2>&1 || true
    docker run -d $SAFE_RUN --memory=5g --name $C --network $RIG-net -p 127.0.0.1:$P:19481 $RIG-img >/dev/null
    sleep 6; docker exec $C mkdir -p /opt/rh
    for f in hub-member.sh ad.mjs hubinit.mjs drive.mjs tg-mock.mjs proxy2.mjs; do docker cp "$K/$f" $C:/opt/rh/ >/dev/null; done
    docker cp "$K/../../../e2e/mock-servers/mock-claude.mjs" $C:/opt/rh/ >/dev/null
    docker exec $C chmod -R a+rX /opt/rh
    docker exec $C bash -c '(setsid node /opt/rh/proxy2.mjs > /tmp/proxy2.log 2>&1 < /dev/null &)'
    echo "container $C up; dashboard (once set up) at http://127.0.0.1:$P" ;;
  run) C=$2; shift 2; docker exec $C bash /opt/rh/hub-member.sh "$@" ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
