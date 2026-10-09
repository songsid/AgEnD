#!/usr/bin/env bash
# #1450 runtime acceptance: a private verdaccio on 127.0.0.1:4873 holding the candidate and its four runtime packages.
# Usage: registry.sh <dir with candidate.json and the packed tarballs> <work dir>
# @songsid/* is served ONLY from what is published here (never proxied, so npmjs's own @songsid packages cannot mix
# in); everything else proxies npmjs. Nothing is published anywhere but this local registry. Writes <work>/npmrc.
set -euo pipefail
PKGS="${1:?packages dir}"; WORK="${2:?work dir}"
REG="http://127.0.0.1:4873/"
mkdir -p "$WORK"
npm install --prefix "$WORK/verdaccio" --no-audit --no-fund --loglevel=error verdaccio@6.1.6 >/dev/null
cat > "$WORK/config.yaml" <<'EOF'
storage: ./storage
auth:
  htpasswd:
    file: ./htpasswd
    max_users: 1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    timeout: 60s
packages:
  '@songsid/*':
    access: $all
    publish: $authenticated
  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs
max_body_size: 300mb
log: { type: stdout, format: pretty, level: warn }
EOF
node "$WORK/verdaccio/node_modules/verdaccio/bin/verdaccio" --config "$WORK/config.yaml" --listen 127.0.0.1:4873 >"$WORK/verdaccio.log" 2>&1 &
echo $! > "$WORK/verdaccio.pid"
for _ in $(seq 60); do curl -fsS "${REG}-/ping" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "${REG}-/ping" >/dev/null || { cat "$WORK/verdaccio.log"; echo "::error::verdaccio did not start"; exit 1; }

# A throwaway local user; its token only means something to this verdaccio.
TOKEN=$(curl -fsS -X PUT -H 'content-type: application/json' -d '{"name":"acceptance","password":"acceptance"}' \
  "${REG}-/user/org.couchdb.user:acceptance" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')
printf 'registry=%s\n//127.0.0.1:4873/:_authToken=%s\n' "$REG" "$TOKEN" > "$WORK/npmrc"

node -e 'for (const t of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tarballs) console.log(t)' "$PKGS/candidate.json" |
while IFS= read -r tarball; do
  npm publish "$PKGS/$tarball" --userconfig "$WORK/npmrc" --registry "$REG" --tag latest --loglevel=error >/dev/null
  echo "  published $tarball to the local registry"
done
