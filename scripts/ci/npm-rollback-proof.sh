#!/usr/bin/env bash
# #1450 PR 0 gate: prove that a global `npm install` which fails in the package's own lifecycle leaves the previously
# installed version in place, on the npm/Node/OS the matrix runs. Option A of docs/design/1450-private-node-runtime.md
# depends on it: the root postinstall refuses (no usable runtime) and npm must roll back.
# Usage: npm-rollback-proof.sh <node binary> <npm-cli.js>
# Everything is inert and offline: local tarballs, a scratch prefix, cache and npmrc, and a registry that is an
# unreachable port. Nothing touches the host's global npm.
set -euo pipefail
NODE="${1:?node binary}"; NPM_CLI="${2:?npm-cli.js}"
WORK="$(mktemp -d "${RBPROOF_TMPDIR:-${TMPDIR:-/tmp}}/rbproof.XXXXXX")"; trap 'rm -rf "${WORK:?}"' EXIT
PREFIX="$WORK/prefix"; mkdir -p "$PREFIX" "$WORK/cache"; : > "$WORK/user.npmrc"; : > "$WORK/global.npmrc"
npm_() {
  env -i HOME="$WORK" PATH="$(dirname "$NODE"):/usr/bin:/bin" \
    npm_config_userconfig="$WORK/user.npmrc" npm_config_globalconfig="$WORK/global.npmrc" npm_config_cache="$WORK/cache" \
    npm_config_prefix="$PREFIX" npm_config_registry="http://127.0.0.1:9/" npm_config_fetch_retries=0 \
    npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false \
    "$NODE" "$NPM_CLI" "$@"
}
pack() { # pack <version> <extra package.json fields as JSON object>
  local dir="$WORK/src-$1"; mkdir -p "$dir"
  "$NODE" -e '
    const [dir, version, extra] = process.argv.slice(1);
    const fs = require("fs");
    fs.writeFileSync(dir + "/package.json", JSON.stringify({ name: "@rbproof/agend", version, bin: { rbproof: "cli.js" }, ...JSON.parse(extra) }));
    fs.writeFileSync(dir + "/cli.js", "#!/usr/bin/env node\nconsole.log(" + JSON.stringify(version) + ")\n", { mode: 0o755 });
    fs.writeFileSync(dir + "/check.js", "process.exit(require(\"fs\").existsSync(__dirname + \"/node_modules/@rbproof/runtime-missing\") ? 0 : 1)\n");
  ' "$dir" "$1" "$2"
  (cd "$dir" && npm_ pack --silent --pack-destination "$WORK" >/dev/null)
  echo "$WORK/rbproof-agend-$1.tgz"
}
installed() { "$PREFIX/bin/rbproof" 2>/dev/null || echo "<none>"; }
fails=0
check() { # check <case> <expected version>
  local got; got="$(installed)"
  if [ "$got" = "$2" ]; then echo "  ok    $1 → $got"; else echo "  FAIL  $1 → $got (expected $2)"; fails=$((fails + 1)); fi
}
echo "node $("$NODE" --version), npm $(npm_ --version), $(uname -s)"
npm_ install -g "$(pack 1.0.0 '{}')" >/dev/null 2>&1
check "baseline install" 1.0.0
for case in \
  'preinstall-fails|{"scripts":{"preinstall":"node -e process.exit(1)"}}' \
  'postinstall-fails|{"scripts":{"postinstall":"node -e process.exit(1)"}}' \
  'optional-dep-unfetchable+postinstall-refuses|{"optionalDependencies":{"@rbproof/runtime-missing":"1.0.0"},"scripts":{"postinstall":"node check.js"}}'
do
  name="${case%%|*}"; fields="${case#*|}"
  if npm_ install -g "$(pack "2.0.0-$name" "$fields")" >/dev/null 2>&1; then echo "  FAIL  $name: npm install succeeded"; fails=$((fails + 1)); fi
  check "$name" 1.0.0
done
npm_ install -g "$(pack 2.0.0 '{}')" >/dev/null 2>&1
check "control: a good v2 replaces v1" 2.0.0
[ "$fails" -eq 0 ] && echo "PASS" || { echo "FAILED ($fails)"; exit 1; }
