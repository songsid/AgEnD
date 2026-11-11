# The rig image: Ubuntu 22.04 + systemd (user managers, linger) + Node 22, run WITHOUT --privileged.
# binfmt units are masked and their entries removed: a privileged systemd container once reset the HOST's binfmt_misc.
FROM node:22-bookworm AS node
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends systemd systemd-sysv libpam-systemd dbus dbus-user-session \
      tmux procps ca-certificates openssl git python3 curl sudo >/dev/null && apt-get clean \
 && (systemctl mask systemd-firstboot.service getty@tty1.service console-getty.service systemd-udevd.service >/dev/null 2>&1 || true) \
 && for u in systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount binfmt-support.service; do ln -sf /dev/null /etc/systemd/system/$u; done \
 && rm -f /usr/lib/binfmt.d/*.conf /etc/binfmt.d/*.conf
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && mkdir -p /var/lib/systemd/linger && useradd -m -s /bin/bash rh && touch /var/lib/systemd/linger/rh
COPY rig-init /usr/local/sbin/rig-init
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/local/sbin/rig-init"]
CMD []
