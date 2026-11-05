# Acceptance witness ONLY. Never register this image as a production execution provider.
ARG PROVIDER_IMAGE=agend-hub-provider-s4b:local
FROM ${PROVIDER_IMAGE}
USER root
RUN apt-get update -qq && apt-get install -y --no-install-recommends tmux >/dev/null && rm -rf /var/lib/apt/lists/*
COPY owner-control.mjs /opt/agend/owner-control.mjs
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/agend/owner-control.mjs"]
