#!/usr/bin/env bash
# #1450 PR 0 gate: prove that a global `npm install` which fails IN THE PACKAGE'S OWN LIFECYCLE leaves the previously
# installed version in place, on the npm/Node/OS the matrix runs. Option A of docs/design/1450-private-node-runtime.md
# depends on it: the root postinstall refuses (no usable runtime) and npm must roll back.
# Usage: npm-rollback-proof.sh <node binary> <npm-cli.js>
#
# Evidence, not just "npm failed and the old bin still prints":
# - every fixture's lifecycle hooks are real JS files that append an event (hook, version, what it saw) to a log;
#   each refusal case must show ITS hook ran and refused — a failure before any hook does not count;
# - after each case the installed package is checked by identity: package.json name/version, the sha256 of its CLI
#   file, and the global bin resolving to exactly that file;
# - negative controls prove the checker itself fails on a failure-before-hooks, a tampered manifest and a wrong bin.
# Everything is inert and offline: local tarballs, a scratch prefix, cache and npmrc, and a registry that is an
# unreachable port. Nothing touches the host's global npm.
set -euo pipefail
NODE="${1:?node binary}"; NPM_CLI="${2:?npm-cli.js}"
WORK="$(mktemp -d "${RBPROOF_TMPDIR:-${TMPDIR:-/tmp}}/rbproof.XXXXXX")"; trap 'rm -rf "${WORK:?}"' EXIT
PREFIX="$WORK/prefix"; EVENTS="$WORK/events.log"
mkdir -p "$PREFIX" "$WORK/cache"; : > "$WORK/user.npmrc"; : > "$WORK/global.npmrc"; : > "$EVENTS"
npm_() {
  env -i HOME="$WORK" PATH="$(dirname "$NODE"):/usr/bin:/bin" RBPROOF_EVENTS="$EVENTS" \
    npm_config_userconfig="$WORK/user.npmrc" npm_config_globalconfig="$WORK/global.npmrc" npm_config_cache="$WORK/cache" \
    npm_config_prefix="$PREFIX" npm_config_registry="http://127.0.0.1:9/" npm_config_fetch_retries=0 \
    npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false \
    "$NODE" "$NPM_CLI" "$@"
}
sha() { "$NODE" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

# pack <version> <hooks: none|pre-refuse|post-refuse|post-runtime-check> <deps: none|optional-missing|required-missing>
pack() {
  local dir="$WORK/src-$1"; mkdir -p "$dir"
  "$NODE" -e '
    const [dir, version, hooks, deps] = process.argv.slice(1);
    const fs = require("fs");
    const pkg = { name: "@rbproof/agend", version, bin: { rbproof: "cli.js" }, scripts: {} };
    if (hooks === "pre-refuse") pkg.scripts.preinstall = "node hook.js preinstall refuse";
    if (hooks === "post-refuse") pkg.scripts.postinstall = "node hook.js postinstall refuse";
    if (hooks === "post-runtime-check") pkg.scripts.postinstall = "node hook.js postinstall runtime";
    if (deps === "optional-missing") pkg.optionalDependencies = { "@rbproof/runtime-missing": "1.0.0" };
    if (deps === "required-missing") pkg.dependencies = { "@rbproof/runtime-missing": "1.0.0" };
    fs.writeFileSync(dir + "/package.json", JSON.stringify(pkg));
    fs.writeFileSync(dir + "/cli.js", "#!/usr/bin/env node\nconsole.log(" + JSON.stringify(version) + ")\n", { mode: 0o755 });
    // The hook records what it is and what it saw, then refuses (exit 1) or, for the runtime check, refuses only when
    // the optional runtime package is absent — the shape of option A`s real postinstall.
    fs.writeFileSync(dir + "/hook.js", [
      "const fs = require(\"fs\"), path = require(\"path\");",
      "const [hook, mode] = process.argv.slice(2);",
      "const version = require(\"./package.json\").version;",
      "const runtime = fs.existsSync(path.join(__dirname, \"node_modules\", \"@rbproof\", \"runtime-missing\")) ? \"present\" : \"absent\";",
      "fs.appendFileSync(process.env.RBPROOF_EVENTS, `${hook} ${version} mode=${mode} runtime=${runtime}\\n`);",
      "process.exit(mode === \"runtime\" && runtime === \"present\" ? 0 : 1);",
    ].join("\n") + "\n");
  ' "$dir" "$1" "$2" "$3"
  (cd "$dir" && npm_ pack --silent --pack-destination "$WORK" >/dev/null)
  echo "$WORK/rbproof-agend-$1.tgz"
}

fails=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; fails=$((fails + 1)); }

# installed_is <prefix> <version> <cli sha256>: the package in <prefix> is exactly the fixture <version>.
installed_is() {
  local prefix="$1" version="$2" want_sha="$3" dir="$1/lib/node_modules/@rbproof/agend"
  local manifest; manifest="$("$NODE" -p 'const p = require(process.argv[1]); p.name + "@" + p.version' "$dir/package.json" 2>/dev/null)" || { echo "no package.json"; return 1; }
  [ "$manifest" = "@rbproof/agend@$version" ] || { echo "manifest is $manifest"; return 1; }
  [ "$(sha "$dir/cli.js" 2>/dev/null)" = "$want_sha" ] || { echo "cli.js bytes differ"; return 1; }
  local target; target="$("$NODE" -p 'require("fs").realpathSync(process.argv[1])' "$prefix/bin/rbproof" 2>/dev/null)" || { echo "no bin"; return 1; }
  [ "$target" = "$("$NODE" -p 'require("fs").realpathSync(process.argv[1])' "$dir/cli.js")" ] || { echo "bin resolves to $target"; return 1; }
  [ "$("$prefix/bin/rbproof")" = "$version" ] || { echo "bin prints something else"; return 1; }
}
# hook_refused <event prefix>: the intended hook ran (and so refused) for this case.
hook_refused() { grep -q "^$1" "$EVENTS"; }

echo "node $("$NODE" --version), npm $(npm_ --version), $(uname -s)"
V1="$(pack 1.0.0 none none)"; npm_ install -g "$V1" >/dev/null 2>&1
V1_SHA="$(sha "$WORK/src-1.0.0/cli.js")"
if why="$(installed_is "$PREFIX" 1.0.0 "$V1_SHA")"; then pass "baseline install → 1.0.0"; else fail "baseline install: $why"; fi

# check_refusal <name> <tarball> <expected event>: npm fails, the expected hook ran, and v1 is intact.
check_refusal() {
  local name="$1" tgz="$2" event="$3" rc=0
  npm_ install -g "$tgz" >"$WORK/npm-$name.log" 2>&1 || rc=$?
  local why=""
  if [ "$rc" -eq 0 ]; then why="npm install succeeded"
  elif ! hook_refused "$event"; then why="npm failed (rc $rc) but not in the intended hook: no \"$event\" event"
  elif ! why="$(installed_is "$PREFIX" 1.0.0 "$V1_SHA")"; then why="v1 not intact after rc $rc: $why"
  else why=""; fi
  if [ -z "$why" ]; then pass "$name → refused in its hook (rc $rc), v1 intact"; return 0; fi
  echo "$why"; return 1
}
for case in \
  "preinstall-fails|pre-refuse|none|preinstall 2.0.0-preinstall-fails mode=refuse" \
  "postinstall-fails|post-refuse|none|postinstall 2.0.0-postinstall-fails mode=refuse" \
  "optional-dep-unfetchable+postinstall-refuses|post-runtime-check|optional-missing|postinstall 2.0.0-optional-dep-unfetchable+postinstall-refuses mode=runtime runtime=absent"
do
  IFS='|' read -r name hooks deps event <<<"$case"
  if out="$(check_refusal "$name" "$(pack "2.0.0-$name" "$hooks" "$deps")" "$event")"; then echo "$out"; else fail "$name: $out"; fi
done

V2="$(pack 2.0.0 none none)"; npm_ install -g "$V2" >/dev/null 2>&1
V2_SHA="$(sha "$WORK/src-2.0.0/cli.js")"
if why="$(installed_is "$PREFIX" 2.0.0 "$V2_SHA")"; then pass "control: a good v2 replaces v1 (identity, bytes, bin)"; else fail "control: good v2: $why"; fi

# Negative controls: the checks above must be able to fail.
# 1. A failure BEFORE any root hook (a required, unfetchable dependency) must not count as a lifecycle refusal.
neg="$(pack 3.0.0-required-dep post-runtime-check required-missing)"
if check_refusal "neg-required-dep" "$neg" "postinstall 3.0.0-required-dep" >/dev/null; then
  fail "negative control: a failure before any hook was accepted as a refusal"
else pass "negative control: a failure before any hook is not accepted"; fi
# 2. A tampered manifest and 3. a bin resolving elsewhere must fail the identity check (on a copy of the prefix).
cp -a "$PREFIX" "$WORK/neg-prefix"
"$NODE" -e 'const f = process.argv[1], p = require(f); p.version = "9.9.9"; require("fs").writeFileSync(f, JSON.stringify(p))' "$WORK/neg-prefix/lib/node_modules/@rbproof/agend/package.json"
if installed_is "$WORK/neg-prefix" 2.0.0 "$V2_SHA" >/dev/null; then fail "negative control: a tampered manifest passed"; else pass "negative control: a tampered manifest is caught"; fi
rm -rf "${WORK:?}/neg-prefix"; cp -a "$PREFIX" "$WORK/neg-prefix"
cp "$WORK/neg-prefix/lib/node_modules/@rbproof/agend/cli.js" "$WORK/elsewhere.js"
ln -sf "$WORK/elsewhere.js" "$WORK/neg-prefix/bin/rbproof"
if installed_is "$WORK/neg-prefix" 2.0.0 "$V2_SHA" >/dev/null; then fail "negative control: a bin resolving elsewhere passed"; else pass "negative control: a bin resolving elsewhere is caught"; fi

# Concurrency (#1450 C1) — CHARACTERIZED, not gated: npm has no mutex between installs into one prefix. A slow
# failing install A overlaps a good install B; what survives is reported so the documented restriction ("never two
# installs at once; AgEnD serializes its own") stays tied to what npm actually does on this npm/OS.
slow_fail="$(pack 4.0.0-slow-fail post-refuse none)"
"$NODE" -e 'const f = process.argv[1]; const s = require("fs").readFileSync(f, "utf8"); require("fs").writeFileSync(f, s.replace("process.exit(", "setTimeout(() => process.exit(").replace(/\);\n$/, "), 3000);\n"))' "$WORK/src-4.0.0-slow-fail/hook.js"
(cd "$WORK/src-4.0.0-slow-fail" && npm_ pack --silent --pack-destination "$WORK" >/dev/null)
good="$(pack 5.0.0 none none)"
npm_ install -g "$slow_fail" >/dev/null 2>&1 & a=$!
sleep 1
b_rc=0; npm_ install -g "$good" >/dev/null 2>&1 || b_rc=$?
a_rc=0; wait "$a" || a_rc=$?
pkg_version="$("$NODE" -p 'try { require(process.argv[1]).version } catch { "<none>" }' "$PREFIX/lib/node_modules/@rbproof/agend/package.json")"
bin_out="$("$PREFIX/bin/rbproof" 2>/dev/null || echo "<none>")"
echo "  info  concurrent: A(slow, failing) rc=$a_rc, B(good) rc=$b_rc → package $pkg_version, bin $bin_out"

[ "$fails" -eq 0 ] && echo "PASS" || { echo "FAILED ($fails)"; exit 1; }
