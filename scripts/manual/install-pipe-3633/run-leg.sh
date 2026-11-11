#!/bin/bash
set -u
printf 'BEFORE tzdata: '; dpkg-query -W -f='${Status}\n' tzdata 2>/dev/null || true
node /evidence/serve.cjs & server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
until curl -fsS http://127.0.0.1:18863/ -o /tmp/ready.sh 2>/dev/null; do sleep .1; done
# A real HTTP stream into bash, with no frontend override inherited from the fixture.
set -o pipefail
curl -fsSL http://127.0.0.1:18863/install.sh | bash
rc=$?
printf '\nPIPELINE_EXIT=%s\n' "$rc"
printf 'AFTER tzdata: '; dpkg-query -W -f='${Status}\n' tzdata 2>/dev/null || true
printf 'PATH_CHECK: '; agend --version </dev/null; version_rc=$?
printf 'VERSION_EXIT=%s\n' "$version_rc"
exit "$rc"
