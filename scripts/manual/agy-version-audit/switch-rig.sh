#!/bin/bash
# Owned netless model/effort capture. No real credentials, fleet or installed CLI changes.
set -euo pipefail
: "${AGY_BIN:?path to the retained binary to COPY}"
: "${AGY_VERSION:?release label for the capture}"
case "$AGY_VERSION" in *[!0-9.]*|'') echo 'numeric version required' >&2; exit 2;; esac
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
rig="$(mktemp -d "${TMPDIR:-/tmp}/agy-model-switch.XXXXXX")"
mkdir -p "$rig"/{home,work,out,cert,bin}; chmod 700 "$rig" "$rig/home"
mkdir -p "$rig/releases/$AGY_VERSION"
cp -- "$AGY_BIN" "$rig/releases/$AGY_VERSION/agy"; chmod 700 "$rig/releases/$AGY_VERSION/agy"
ln -s "../releases/$AGY_VERSION/agy" "$rig/bin/agy"
cp -- "$script_dir/switch-rig.py" "$rig/switch-rig.py"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$rig/cert/key.pem" -out "$rig/cert/cert.pem" -days 2 \
 -subj '/CN=daily-cloudcode-pa.googleapis.com' \
 -addext 'subjectAltName=DNS:daily-cloudcode-pa.googleapis.com,DNS:www.googleapis.com,DNS:play.googleapis.com,DNS:cloudcode-pa.googleapis.com,DNS:oauth2.googleapis.com' > "$rig/cert/generate.log" 2>&1
printf '%s\n' '127.0.0.1 localhost daily-cloudcode-pa.googleapis.com www.googleapis.com play.googleapis.com cloudcode-pa.googleapis.com oauth2.googleapis.com' > "$rig/hosts"
sha256sum "$rig/bin/agy" > "$rig/binary.sha256"
extra=()
if [[ "${DAEMON_PROOF:-0}" == 1 ]]; then
 repo="$(cd -- "$script_dir/../../.." && pwd)"
 deps="$(readlink -f "$repo/node_modules")"
 cp -- "$(command -v node)" "$rig/bin/node"
 extra=(--dir /repo --ro-bind "$repo/src" /repo/src --ro-bind "$repo/launcher" /repo/launcher --ro-bind "$repo/scripts/manual/agy-version-audit" /repo/scripts/manual/agy-version-audit --ro-bind "$repo/package.json" /repo/package.json --ro-bind "$deps" /repo/node_modules)
fi
# Only this user/network namespace gets low-port privilege; the host has no listener or hosts-file change.
bwrap --unshare-all --uid 0 --gid 0 --cap-add CAP_NET_BIND_SERVICE --die-with-parent \
 --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --proc /proc --dev /dev --tmpfs /tmp \
 --dir /etc --ro-bind "$rig/hosts" /etc/hosts --bind "$rig" /rig --bind "$rig/home" /home/rig --bind "$rig/work" /work \
 "${extra[@]}" --clearenv --setenv DAEMON_PROOF "${DAEMON_PROOF:-0}" --setenv RIG_VERSION "$AGY_VERSION" --setenv HOME /home/rig --setenv PATH /rig/bin:/usr/bin:/bin --setenv TERM xterm-256color \
 --setenv LANG C.UTF-8 --setenv SSL_CERT_FILE /rig/cert/cert.pem --chdir /work python3 /rig/switch-rig.py > "$rig/controller.log" 2>&1
printf 'Owned capture retained at %s\n' "$rig"
