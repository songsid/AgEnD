#!/usr/bin/env bash
# M-3806: reproduce npm hiding a global prefix whose path contains a UUID, and prove the fix, with REAL npm 10, 11 and
# 12 on scratch prefixes. Never touches the host's global npm, its live install, or a fleet: every install goes to
# $R/p-*, with HOME and AGEND_HOME under $R, and the installer sees only its own process ancestry.
#
#   scripts/manual/npm-masked-prefix-m3806/repro.sh <candidate.tgz> <install.sh before> <install.sh after> [scratch dir]
#
# The candidate is `npm pack` of this branch (built), its version set to 2.4.0-m3806.1 so it is never mistaken for a
# release. The prefix is set the usual way, in the user's .npmrc (`prefix=...`). Needs the network (the published
# 2.4.0-beta.24 and the bundled Node package). The scratch dir must not itself contain a UUID.
# Output: one log; scratch paths are printed as <scratch>.
set -uo pipefail
abs() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
CAND=$(abs "$1"); SH_BEFORE=$(abs "$2"); SH_AFTER=$(abs "$3")
R=${4:-$(mktemp -d)}
mkdir -p "$R"
# Not inside a checkout: `npm exec` in a folder whose package.json is @songsid/agend runs THAT package's bin instead.
cd "$R" || exit 1
PUBLISHED=2.4.0-beta.24
UUID=0b7e5a2c-3f1d-4c6e-9a8b-1234567890ab
step() { printf '\n=== %s\n' "$*"; }
redact() { sed -e "s#$R#<scratch>#g" -e "s#$HOME#~#g"; }

for v in 10.9.7 11.21.3 12.2.3; do
  [ -x "$R/npm-$v/node_modules/.bin/npm" ] || npm install --prefix "$R/npm-$v" "npm@$v" --no-audit --no-fund >/dev/null 2>&1
  mkdir -p "$R/bin-$v"
  ln -sf "$R/npm-$v/node_modules/.bin/npm" "$R/bin-$v/npm"
  cat > "$R/bin-$v/ps" <<'PS'
#!/bin/sh
/bin/ps -A -o pid=,ppid=,args= | awk -v start=$PPID '{ parent[$1] = $2; line[$1] = $0 } END { p = start; while (p > 1 && (p in line) && !(p in seen)) { seen[p] = 1; print line[p]; p = parent[p] } }'
PS
  chmod +x "$R/bin-$v/ps"
done
mkdir -p "$R/home"
# npm <v> first on PATH, a scratch HOME/AGEND_HOME/cache, and the prefix in a .npmrc of the step's own.
with() { local v=$1 prefix=$2; shift 2; printf 'prefix=%s\n' "$prefix" > "$R/npmrc-$(basename "$prefix")"
  env -i PATH="$R/bin-$v:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$R/home" AGEND_HOME="$R/home/.agend" \
  npm_config_userconfig="$R/npmrc-$(basename "$prefix")" npm_config_cache="$R/cache" npm_config_update_notifier=false \
  npm_config_fund=false npm_config_audit=false npm_config_allow_scripts=@songsid/agend LANG=C.UTF-8 "$@"; }
agend_version() { env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$R/home" "$1/bin/agend" --version 2>&1; echo "(exit $?)"; }
prefix_step() { sed -n '/^# >>> npm-prefix sudo/,/^# <<< npm-prefix sudo/p' "$1"; }

{
step "versions"; for v in 10.9.7 11.21.3 12.2.3; do echo "npm $(with $v "$R/p-v" npm --version) on node $(node --version)"; done

step "1. What npm says about a global prefix with a UUID in its path (<scratch>/p-$UUID, from the user's .npmrc)"
P="$R/p-$UUID"; mkdir -p "$P/lib"
for v in 10.9.7 11.21.3 12.2.3; do
  echo "--- npm $v"
  echo "npm prefix -g        → $(with $v "$P" npm prefix -g 2>&1 | tail -1)"
  echo "npm root -g          → $(with $v "$P" npm root -g 2>&1 | tail -1)"
  out=$(with $v "$P" npm config get prefix 2>&1); rc=$?
  echo "npm config get prefix → (exit $rc) $(printf '%s\n' "$out" | head -1)"
  echo "npm exec -c (child)  → $(with $v "$P" npm exec -c 'node -p process.env.npm_config_global_prefix' 2>/dev/null | tail -1)"
done

for v in 12.2.3 11.21.3; do
  step "2. BEFORE: the published $PUBLISHED installer into a UUID prefix, npm $v (scripts allowed, so M-3805 is not the cause)"
  rm -rf "$R/home/.agend"; P="$R/p-before-$v-$UUID"
  with "$v" "$P" npm exec --yes --package "@songsid/agend@$PUBLISHED" -- agend-install 2>&1 | grep -E "✓|✗|AgEnD v|npm error" | head -6
  agend_version "$P"
done

for v in 12.2.3 11.21.3 10.9.7; do
  step "3. AFTER: the candidate's installer into a UUID prefix, npm $v"
  rm -rf "$R/home/.agend"; P="$R/p-after-$v-$UUID"
  with "$v" "$P" npm exec --yes --package "$CAND" -- agend-install --spec "$CAND" 2>&1 | grep -E "✓|✗|AgEnD v|npm error" | head -6
  agend_version "$P"
done

step "4. install.sh's prefix/sudo step with real npm, prefix <scratch>/home/.npm-$UUID (does not exist yet)"
for v in 12.2.3 10.9.7; do
  for which in before after; do
    rm -rf "$R/home/.npm-$UUID"
    sh_file=$SH_BEFORE; [ "$which" = after ] && sh_file=$SH_AFTER
    echo "--- npm $v, $which:"
    with "$v" "$R/home/.npm-$UUID" bash -c "set -euo pipefail
error() { echo \"  error: \$1\"; exit 1; }
SUDO=sudo
$(prefix_step "$sh_file")
echo \"  NPM_PREFIX=\$NPM_PREFIX  SUDO=\${SUDO:-<none>}\"" 2>&1
    echo "  created: $(ls -d "$R/home/.npm-$UUID/lib" 2>/dev/null || echo nothing)"
  done
done
} 2>&1 | redact
