#!/bin/bash
# Real terminal, dummy model API, no host HOME or network. Never launch a Fleet.
set -euo pipefail
: "${GROK_BIN:?retained real binary}"
: "${AUDIT_DIR:?owned scratch output directory}"
rig_source="$(cd -- "$(dirname -- "$0")" && pwd)"
mkdir -p "$AUDIT_DIR"; chmod 700 "$AUDIT_DIR"
audit_root="$(cd -- "$AUDIT_DIR" && pwd)"
binary="$(realpath -- "$GROK_BIN")"
audit_node="$(realpath -- "$(command -v node)")"
bwrap --unshare-all --die-with-parent \
 --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin \
 --proc /proc --dev /dev --tmpfs /tmp --bind "$audit_root" /rig \
 --ro-bind "$rig_source" /harness --ro-bind "$binary" /audit-grok \
 --ro-bind "$audit_node" /audit-node \
 --clearenv --setenv HOME /rig/home --setenv PATH /usr/bin:/bin \
 --setenv TERM xterm-256color --setenv LANG C.UTF-8 \
 --setenv AUDIT_PHASE "${AUDIT_PHASE:-probe}" \
 --chdir /rig python3 /harness/controller.py
