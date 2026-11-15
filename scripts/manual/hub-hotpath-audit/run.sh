#!/usr/bin/env bash
# Owned netless loopback rig. Real protocol endpoints; synthetic vendor agents, never a live Fleet.
set -euo pipefail
repo="$(cd -- "$(dirname -- "$0")/../../.." && pwd)"
rig="$(mktemp -d "${TMPDIR:-/tmp}/agend-hub-hotpaths.XXXXXX")"
mkdir -p "$rig"/{home,bin,out,artifacts}; chmod 700 "$rig" "$rig/home"
cp -- "$(command -v node)" "$rig/bin/node"
deps="$(readlink -f "$repo/node_modules")"
mounts=(--dir /repo --bind "$deps" /repo/node_modules)
for entry in src tests scripts launcher assets package.json tsconfig.json tsconfig.test.json vitest.config.ts; do
 if [[ -e "$repo/$entry" ]]; then mounts+=(--ro-bind "$repo/$entry" "/repo/$entry"); fi
done
suites=(tests/hub-hotpath-measure-m3184.test.ts tests/hub-socket-deadline-m3184.test.ts
 tests/hub-join-deadline-m3184.test.ts tests/hub-runtime-hotpath-m3184.test.ts
 tests/hub-native-catalog-m3184.test.ts tests/native-mcp.test.ts
 tests/mcp-tool-list-startup-m3183.test.ts tests/hub-company-join-client.test.ts
 tests/hub-member-startup-3171.test.ts tests/hub-web-address-http-3428.test.ts
 tests/hub-member-address-http-3429.test.ts)
if (( $# )); then suites=("$@"); fi
bwrap --unshare-all --die-with-parent \
 --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --proc /proc --dev /dev --tmpfs /tmp \
 --dir /etc --dir /etc/ssl --ro-bind /etc/ssl/openssl.cnf /etc/ssl/openssl.cnf --ro-bind /etc/ssl/certs /etc/ssl/certs --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf \
 --dir /home --bind "$rig/home" /home/rig "${mounts[@]}" \
 --bind "$rig/artifacts" /repo/.artifacts --ro-bind "$rig/bin" /rig-bin --bind "$rig/out" /out \
 --clearenv --setenv HOME /home/rig --setenv PATH /rig-bin:/usr/bin:/bin --setenv LANG C.UTF-8 --setenv TZ UTC \
 --setenv AGEND_M3184_EVIDENCE_DIR /out --chdir /repo \
 /rig-bin/node /repo/node_modules/vitest/vitest.mjs run "${suites[@]}" --maxWorkers=2 > "$rig/out/focused.log" 2>&1
printf 'Owned netless evidence: %s\n' "$rig/out"
