#!/bin/bash
# Copy only the retained binary. All network, HOME and tmux state are isolated and fake.
set -euo pipefail
: "${GROK_BIN:?path to binary to COPY}"
: "${GROK_VERSION:?release label}"
case "$GROK_VERSION" in *[!0-9.]*|'') echo 'numeric version required' >&2; exit 2;; esac
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
rig="$(mktemp -d "${TMPDIR:-/tmp}/grok-model-switch.XXXXXX")"
mkdir -p "$rig"/{home,work,out,bin}; chmod 700 "$rig" "$rig/home"
mkdir -p "$rig/releases/$GROK_VERSION"
cp -- "$GROK_BIN" "$rig/releases/$GROK_VERSION/grok"; chmod 700 "$rig/releases/$GROK_VERSION/grok"
ln -s "../releases/$GROK_VERSION/grok" "$rig/bin/grok"
cp -- "$script_dir/switch-rig.py" "$rig/switch-rig.py"
sha256sum "$rig/bin/grok" > "$rig/binary.sha256"
extra=()
if [[ "${DAEMON_PROOF:-0}" == 1 ]]; then
 repo="$(cd -- "$script_dir/../../.." && pwd)"
 deps="$(readlink -f "$repo/node_modules")"
 cp -- "$(command -v node)" "$rig/bin/node"
 extra=(--dir /repo --ro-bind "$repo/src" /repo/src --ro-bind "$repo/launcher" /repo/launcher --ro-bind "$repo/scripts/manual/grok-version-audit" /repo/scripts/manual/grok-version-audit --ro-bind "$repo/package.json" /repo/package.json --ro-bind "$deps" /repo/node_modules)
fi
bwrap --unshare-all --die-with-parent --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin \
 --proc /proc --dev /dev --tmpfs /tmp --bind "$rig" /rig --bind "$rig/home" /home/rig --bind "$rig/work" /work \
 "${extra[@]}" --clearenv --setenv DAEMON_PROOF "${DAEMON_PROOF:-0}" --setenv RIG_VERSION "$GROK_VERSION" --setenv HOME /home/rig --setenv PATH /rig/bin:/usr/bin:/bin --setenv TERM xterm-256color --setenv LANG C.UTF-8 \
 --setenv XAI_API_KEY xai-dummy-rig --setenv GROK_XAI_API_BASE_URL http://127.0.0.1:18080/v1 --setenv XAI_API_BASE_URL http://127.0.0.1:18080/v1 \
 --setenv GROK_CLI_BASE_URL http://127.0.0.1:18080 --setenv GROK_FOLDER_TRUST 1 --chdir /work python3 /rig/switch-rig.py > "$rig/controller.log" 2>&1
printf 'Owned capture retained at %s\n' "$rig"
