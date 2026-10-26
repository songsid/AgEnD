#!/bin/sh
# Build the AgEnD image from this checkout (#581): until ghcr.io/songsid/agend is published, this is how to get an
# image whose AgEnD has `agend container prepare` — the npm release may predate it. Run from anywhere in the repo;
# then `docker compose up -d` in docker/. To update later: git pull, run this again, docker compose up -d.
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
npm ci
npm run build
rm -f docker/*.tgz
npm pack --pack-destination docker >/dev/null
pkg="$(basename docker/*.tgz)"
cd docker
AGEND_PACKAGE="/ctx/$pkg" docker compose build
rm -f "$pkg"
echo "Built the image from $(git -C "$repo" rev-parse --short HEAD). Start it with: docker compose up -d (in docker/)"
