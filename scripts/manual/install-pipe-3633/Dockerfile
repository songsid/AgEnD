FROM node:22-bookworm-slim AS node
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* && ! dpkg-query -W -f='${Status}' tzdata 2>/dev/null | grep -q 'install ok installed'
COPY --from=node /usr/local/ /usr/local/
WORKDIR /rig
