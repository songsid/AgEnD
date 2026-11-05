#!/usr/bin/env bash
# The AgEnD Hub fake directory (S-43): build, start, inspect and stop it. Test rig only; never point the Hub's real
# configuration at it, and never point these tests at a real directory.
#
#   run.sh up   [NAME]   build the image, start the container, wait until it answers, write $OUT/rig.env
#   run.sh down [NAME]   remove the container (nothing persists: every file lives in the container's tmpfs)
#   run.sh env  [NAME]   print the rig.env path
#   run.sh exec [NAME] -- CMD...   run an ldap* tool inside the container (see README.md for scenarios)
#
# Container rules (fleet policy): never --privileged, no host network, no systemd/binfmt, no iptables/route/resolv
# changes. The container runs as the unprivileged ldap user with every capability dropped, a read-only root and
# ports published on 127.0.0.1 only.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cmd=${1:-}; shift || true
name=${1:-agend-hub-directory-rig}; [ $# -gt 0 ] && shift
image=${AGEND_HUB_RIG_IMAGE:-agend-hub-directory-rig:local}
out=${OUT:-${XDG_CACHE_HOME:-$HOME/.cache}/agend-hub-directory-rig/$name}

case "$cmd" in
  up)
    docker build -q -t "$image" "$here" >/dev/null
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" \
      --read-only --tmpfs /run/rig:uid=100,gid=101,mode=0700 \
      --cap-drop ALL --security-opt no-new-privileges \
      -p 127.0.0.1::1636 -p 127.0.0.1::1389 \
      "$image" >/dev/null
    for _ in $(seq 1 150); do
      docker exec "$name" test -e /run/rig/ready 2>/dev/null && break
      if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != true ]; then
        docker logs "$name" >&2 || true; echo "run.sh: the rig container stopped" >&2; exit 1
      fi
      sleep 0.2
    done
    docker exec "$name" test -e /run/rig/ready || { docker logs "$name" >&2; echo "run.sh: the rig never became ready" >&2; exit 1; }
    ldaps=$(docker port "$name" 1636/tcp | head -n 1); ldap=$(docker port "$name" 1389/tcp | head -n 1)
    mkdir -p "$out"; chmod 700 "$out"
    docker exec "$name" cat /run/rig/tls/ca.pem > "$out/ca.pem"
    docker exec "$name" cat /run/rig/tls/other-ca.pem > "$out/other-ca.pem"
    umask 077
    {
      echo "AGEND_HUB_RIG=1"
      echo "AGEND_HUB_RIG_LDAPS_URL=ldaps://$ldaps"
      echo "AGEND_HUB_RIG_LDAP_URL=ldap://$ldap"
      echo "AGEND_HUB_RIG_CA=$out/ca.pem"
      echo "AGEND_HUB_RIG_OTHER_CA=$out/other-ca.pem"
      echo "AGEND_HUB_RIG_BASE_DN=dc=example,dc=test"
      echo "AGEND_HUB_RIG_ADMIN_DN=cn=admin,dc=example,dc=test"
      echo "AGEND_HUB_RIG_ADMIN_PASSWORD=$(docker exec "$name" cat /run/rig/secrets/admin)"
      echo "AGEND_HUB_RIG_BIND_DN=cn=hub-reader,ou=service,dc=example,dc=test"
      echo "AGEND_HUB_RIG_BIND_PASSWORD=$(docker exec "$name" cat /run/rig/secrets/reader)"
      echo "AGEND_HUB_RIG_SEED_PASSWORD=$(docker exec "$name" cat /run/rig/secrets/seed)"
    } > "$out/rig.env"
    echo "$out/rig.env"
    ;;
  down) docker rm -f "$name" >/dev/null 2>&1 || true; rm -f "$out/rig.env" "$out/ca.pem" "$out/other-ca.pem" ;;
  env) echo "$out/rig.env" ;;
  exec) [ "${1:-}" = -- ] && shift; docker exec -e LDAPTLS_CACERT=/run/rig/tls/ca.pem "$name" "$@" ;;
  *) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac
