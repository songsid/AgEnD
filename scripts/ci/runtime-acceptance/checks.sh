# #1450 runtime acceptance: the checks every leg runs on an installed candidate. Sourced, not run.
# Needs: PREFIX (the scratch npm prefix), CAND (candidate version), PIN (bundled Node x.y.z), SYS_NODE/SYS_NODE_VERSION
# (the system Node as found before anything was installed). Sets RT_NODE (realpath of the selected Node).

fail() { echo "::error::$*"; exit 1; }
step() { printf '\n== %s\n' "$*"; }
realpath_of() { node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$1"; }

# Prove the bundled Node of this release is what AgEnD runs on, and that it works.
check_installed() {
  local bin="$PREFIX/bin/agend" pkg="$PREFIX/lib/node_modules/@songsid/agend" id sel want
  id="$(node -p 'process.platform + "-" + process.arch')"

  step "agend --version is the candidate"
  local v; v="$("$bin" --version)"
  echo "  $v"
  [ "$v" = "$CAND" ] || fail "agend --version printed '$v', not $CAND"

  step "the selection is the bundled Node (system Node: $SYS_NODE_VERSION)"
  sel="$("$bin" --agend-select-json)"
  echo "  $sel"
  want="$(realpath_of "$pkg/node_modules/@songsid/agend-node-$id/bin/node")"
  RT_NODE="$(node -pe 'const s = JSON.parse(process.argv[1]); s.source === "runtime" ? s.node : ""' "$sel")"
  [ "$RT_NODE" = "$want" ] || fail "selected '$RT_NODE' (source not runtime?), expected the bundled $want"
  [ "$("$RT_NODE" --version)" = "v$PIN" ] || fail "the bundled Node is $("$RT_NODE" --version), not v$PIN"
  [ -f "$pkg/.agend-runtime.json" ] || fail "no receipt: the postinstall did not verify the runtime"
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (r.nodePath !== process.argv[2] || r.pinnedVersion !== process.argv[3]) { console.error(r); process.exit(1); }
    console.log(`  receipt: ${r.nodePath} sha256 ${r.sha256.slice(0, 16)}… verified ${r.verifiedAt}`);
  ' "$pkg/.agend-runtime.json" "$RT_NODE" "$PIN" || fail "the receipt does not describe the selected Node"

  step "a database opens on the bundled Node, in the main thread and in a worker"
  "$RT_NODE" -e '
    const { Worker } = require("node:worker_threads");
    // One function, run in this thread and then (as source) in a worker: open a file DB, add a row, count the rows.
    function addRow(pkg, file) {
      const D = require("node:module").createRequire(pkg + "/package.json")("better-sqlite3");
      const db = new D(file);
      db.exec("create table if not exists t(x)");
      db.prepare("insert into t values (1)").run();
      const n = db.prepare("select count(*) as n from t").get().n;
      db.close();
      return n;
    }
    const [pkg, file] = process.argv.slice(1);
    const main = addRow(pkg, file);
    const w = new Worker(`${addRow}; require("node:worker_threads").parentPort.postMessage(addRow(${JSON.stringify(pkg)}, ${JSON.stringify(file)}))`, { eval: true });
    w.on("message", n => { console.log(`  main thread: ${main} row(s); then the worker: ${n}`); process.exit(n === main + 1 ? 0 : 1); });
    w.on("error", e => { console.error(e); process.exit(1); });
  ' "$pkg" "$WORK/acceptance-$RANDOM.db" || fail "better-sqlite3 did not open a database on the bundled Node"

  step "the system Node is untouched, and the runtime is on no PATH"
  [ "$(command -v node)" = "$SYS_NODE" ] || fail "command -v node is $(command -v node), was $SYS_NODE"
  [ "$(node --version)" = "$SYS_NODE_VERSION" ] || fail "node --version is $(node --version), was $SYS_NODE_VERSION"
  case ":$PATH:" in *"/agend-node-"*) fail "a runtime directory is on PATH: $PATH" ;; esac
  echo "  $SYS_NODE $SYS_NODE_VERSION"
}

# A PATH with this host's ordinary tools and NO Node at all: /usr/bin and /bin (plus tmux) as links, minus node, npm,
# npx and corepack. Prints the directory.
no_node_path() {
  local farm="$WORK/no-node-bin" f name
  rm -rf "$farm"; mkdir -p "$farm"
  for f in /usr/bin/* /bin/* "$(command -v tmux)"; do
    name=$(basename "$f")
    case $name in node | nodejs | npm | npx | corepack) continue ;; esac
    [ -x "$f" ] && [ ! -e "$farm/$name" ] && ln -s "$f" "$farm/$name"
  done
  echo "$farm"
}

# D1: `agend` ITSELF — npm's bin link to the sh launcher, not `<node> launcher` — with no node on PATH: --version,
# the selection, and the scratch daemon.
check_no_system_node() {
  local bin="$PREFIX/bin/agend" path sel v
  path="$PREFIX/bin:$(no_node_path)"
  step "agend itself (npm's bin link → the sh launcher) with NO node on PATH"
  if env PATH="$path" sh -c 'command -v node'; then fail "node is still reachable on the restricted PATH"; fi
  v="$(env PATH="$path" "$bin" --version)" || fail "agend --version failed with no node on PATH"
  [ "$v" = "$CAND" ] || fail "agend --version printed '$v' with no node on PATH"
  sel="$(env PATH="$path" "$bin" --agend-select-json)" || fail "agend --agend-select-json failed with no node on PATH"
  [ "$(node -pe 'JSON.parse(process.argv[1]).node' "$sel")" = "$RT_NODE" ] || fail "with no node on PATH the selection is $sel"
  echo "  --version $v; selected $RT_NODE"
  NO_NODE_PATH="$path" check_daemon
}

# Start a scratch fleet with no instances (isolated HOME/AGEND_HOME, a private tmux socket), prove the daemon process
# IS the bundled Node, then stop it. With NO_NODE_PATH set, the fleet is started and stopped on that PATH.
check_daemon() {
  local bin="$PREFIX/bin/agend" port=19391 fpid exe launcher
  local -a run=()
  [ -n "${NO_NODE_PATH:-}" ] && run=(env "PATH=$NO_NODE_PATH")
  step "a scratch daemon runs on the bundled Node${NO_NODE_PATH:+ (no node on PATH)}"
  mkdir -p "$AGEND_HOME"
  rm -f "$AGEND_HOME/fleet.pid"
  printf 'health_port: %s\ninstances: {}\n' "$port" > "$AGEND_HOME/fleet.yaml"
  ${run[@]+"${run[@]}"} "$bin" fleet start >"$WORK/fleet.out" 2>&1 &
  launcher=$!
  for _ in $(seq 90); do
    [ -s "$AGEND_HOME/fleet.pid" ] && curl -s -o /dev/null "http://127.0.0.1:$port/health" && break
    kill -0 "$launcher" 2>/dev/null || break
    sleep 1
  done
  [ -s "$AGEND_HOME/fleet.pid" ] && curl -s -o /dev/null "http://127.0.0.1:$port/health" || { cat "$WORK/fleet.out"; fail "the scratch fleet did not come up"; }
  fpid="$(cat "$AGEND_HOME/fleet.pid")"
  if [ -e "/proc/$fpid/exe" ]; then exe="$(readlink "/proc/$fpid/exe")"; else exe="$(ps -o comm= -p "$fpid")"; fi
  echo "  fleet pid $fpid runs $exe"
  [ "$(realpath_of "$exe")" = "$RT_NODE" ] || fail "the daemon runs $exe, not the bundled $RT_NODE"
  ${run[@]+"${run[@]}"} "$bin" fleet stop --yes
  for _ in $(seq 60); do kill -0 "$fpid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$fpid" 2>/dev/null; then cat "$WORK/fleet.out"; fail "the scratch fleet did not stop"; fi
  wait "$launcher" 2>/dev/null || true
  echo "  stopped"
}

# What a service definition written by this install would start. CI checks the file's contents and paths only: it
# cannot prove a systemd user service or launchd loads it at boot/login.
check_service_files() {
  local bin="$PREFIX/bin/agend" file argv0
  step "agend install --no-activate writes a service that starts the bundled Node"
  "$bin" install --no-activate
  if [ "$(uname)" = "Darwin" ]; then
    file="$HOME/Library/LaunchAgents/com.agend.fleet.plist"
    argv0="$(plutil -extract ProgramArguments.0 raw -o - "$file")"
  else
    file="$HOME/.config/systemd/user/com.agend.fleet.service"
    argv0="$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$file")"
  fi
  cat "$file"
  [ "$argv0" = "$RT_NODE" ] || fail "the service starts '$argv0', not the bundled $RT_NODE (C6, #1450 PR 3)"
}
