# AgEnD's container image (#581): AgEnD + tmux on Node 22, no CLI backends baked in. The entrypoint installs the
# CLIs fleet.yaml uses into the home volume on first start (agend container prepare), then runs the fleet in the
# foreground; Docker's restart policy supervises it. See docs/docker.md.
FROM node:22-bookworm-slim

# What `npm install -g` installs: a published version (the default), or — for a local build — a tarball from
# `npm pack` placed next to this Dockerfile and named as /ctx/<file>.tgz.
ARG AGEND_PACKAGE=@songsid/agend@latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps xz-utils unzip less tini bash \
 && rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,source=.,target=/ctx \
    npm install -g "$AGEND_PACKAGE" && npm cache clean --force

# The base image's uid-1000 user, renamed: a person's bind mount (uid 1000 on most hosts) matches it.
RUN groupmod -n agend node \
 && usermod -l agend -d /home/agend -m -c AgEnD node \
 && mkdir -p /work && chown agend:agend /work

COPY agend-container /usr/local/bin/agend-container

# AGEND_CONTAINER: `agend update` / `install` / `stop` refuse and say what to run on the host instead; `restart` lets
# Docker restart the container. AGEND_WEB_BIND: the dashboard listens on the container's interfaces (compose
# publishes it on the host's 127.0.0.1). The CLIs' own self-updates stay off, so a pinned version holds.
ENV AGEND_CONTAINER=1 \
    AGEND_WEB_BIND=0.0.0.0 \
    HOME=/home/agend \
    PATH=/home/agend/.local/bin:/home/agend/.opencode/bin:/home/agend/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISABLE_AUTOUPDATER=1 KIRO_NO_AUTO_UPDATE=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
    TERM=xterm-256color LANG=C.UTF-8

USER agend
WORKDIR /home/agend
VOLUME ["/home/agend", "/work"]
EXPOSE 19280
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 CMD curl -fsS http://127.0.0.1:19280/health >/dev/null || exit 1
# tini as PID 1 reaps the CLIs' children: without it a killed CLI stays a zombie that still holds its session lock.
ENTRYPOINT ["tini", "--", "agend-container"]
