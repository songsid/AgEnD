#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
binary="$(realpath "$1")"
output="$(realpath "$2")"
nice -n 10 ionice -c 2 -n 7 bwrap --unshare-all --hostname offline-muse-audit --die-with-parent --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --proc /proc --dev /dev --tmpfs /tmp --bind "$output" /home/u --ro-bind "$root/rig" /harness --ro-bind "$binary" /audit-muse --clearenv --setenv WIDTHS "${WIDTHS:-120,80}" --setenv AUDIT_PHASE "${AUDIT_PHASE:-full}" --setenv HOME /home/u --setenv PATH /usr/bin:/bin --setenv TERM xterm-256color --setenv LANG C.UTF-8 --chdir /home/u /usr/bin/python3 /harness/controller.py
