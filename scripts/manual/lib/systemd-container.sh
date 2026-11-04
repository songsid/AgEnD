# shellcheck shell=bash
# Source this from a manual rehearsal that boots systemd in a Docker container.
#
# binfmt_misc is host-global: on WSL's kernel it is not namespaced. A systemd container started with --privileged
# runs systemd-binfmt.service, which clears every registered entry on the HOST (WSLInterop included: Windows interop
# then fails machine-wide with "Exec format error") and registers its own (python3.10 in agend-rh-b16-bus). That
# happened on 2026-11-04. So a rehearsal container:
#   - never runs --privileged: the flags are SYSTEMD_CONTAINER_FLAGS below (/proc/sys stays read-only);
#   - runs a derived image with every binfmt unit masked and every binfmt.d entry removed (systemd_container_image);
#   - refuses to start when the image it is about to run still has an enabled binfmt unit or a binfmt.d entry
#     (systemd_container_guard), so a future image cannot bring it back.

# CAP_SYS_ADMIN lets the image's entrypoint remount the container's OWN cgroup2 read-write (a private cgroup namespace:
# it is the container's subtree, not the host's), which systemd needs as PID 1. Nothing else of the host is writable.
SYSTEMD_CONTAINER_FLAGS=(--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined
  --cgroupns=private --tmpfs /run --tmpfs /run/lock)

# systemd_container_image <base image>: prints the name of <base>-nobinfmt, building it when missing (no network).
# The derived image masks the binfmt units, removes the binfmt.d entries, and boots systemd through an entrypoint that
# makes only the container's own cgroup2 writable.
systemd_container_image() {
  local base=$1 derived
  case $base in *-nobinfmt) derived=$base ;; *) derived=$base-nobinfmt ;; esac
  if ! docker image inspect "$derived" > /dev/null 2>&1; then
    docker build -q --network none -t "$derived" - > /dev/null <<DOCKERFILE || { echo "could not build $derived from $base" >&2; return 1; }
FROM $base
RUN for u in systemd-binfmt.service binfmt-support.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount; do ln -sf /dev/null /etc/systemd/system/\$u; done \\
 && rm -f /usr/lib/binfmt.d/* /lib/binfmt.d/* /etc/binfmt.d/* /usr/local/lib/binfmt.d/* \\
 && printf '#!/bin/sh\nmount -o remount,rw /sys/fs/cgroup || exit 1\nexec /lib/systemd/systemd "\$@"\n' > /usr/local/sbin/systemd-container-init \\
 && chmod 755 /usr/local/sbin/systemd-container-init
ENTRYPOINT ["/usr/local/sbin/systemd-container-init"]
CMD []
DOCKERFILE
  fi
  printf '%s\n' "$derived"
}

# systemd_container_guard <image>: exit status 0 only when the image has no binfmt unit that could run and no binfmt.d
# entry. Checked inside a throwaway container with no network, no privileges and no systemd running.
systemd_container_guard() {
  local found
  found=$(docker run --rm --network none --entrypoint /bin/sh "$1" -c '
    for u in systemd-binfmt.service binfmt-support.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount; do
      for d in /lib/systemd/system /usr/lib/systemd/system; do
        if [ -e "$d/$u" ] && [ "$(readlink -f /etc/systemd/system/$u 2>/dev/null)" != /dev/null ]; then echo "unit $u is not masked"; break; fi
      done
    done
    for d in /usr/lib/binfmt.d /lib/binfmt.d /etc/binfmt.d /usr/local/lib/binfmt.d /run/binfmt.d; do
      for f in "$d"/*; do [ -e "$f" ] && echo "binfmt.d entry $f"; done
    done
    [ -x /usr/local/sbin/systemd-container-init ] || echo "no non-privileged systemd entrypoint"
    exit 0' 2>&1) || { echo "could not inspect $1: $found" >&2; return 1; }
  if [ -n "$found" ]; then
    printf 'Refusing to start %s: it could change the host binfmt_misc (or cannot boot without --privileged):\n%s\n' "$1" "$found" >&2
    return 1
  fi
}
