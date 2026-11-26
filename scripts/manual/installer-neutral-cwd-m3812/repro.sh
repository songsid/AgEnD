#!/usr/bin/env bash
# M-3812: reproduce `npm exec … -- agend-install` running the installer on a project's own node when started inside
# that project, and prove the fix in install.sh's installer step, with REAL npm 12 and 10 on scratch prefixes. Never
# touches the host's global npm, its live install, or a fleet: every install goes to $R/p-*, with HOME and AGEND_HOME
# under $R, and the installer sees only its own process ancestry.
#
#   scripts/manual/installer-neutral-cwd-m3812/repro.sh <install.sh before> <install.sh after> [scratch dir]
#
# The installer is the published 2.4.0-beta.24's (the launch is what changed, not the installer). Needs the network.
# Output: one log; scratch paths are printed as <scratch>.
set -uo pipefail
abs() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
SH_BEFORE=$(abs "$1"); SH_AFTER=$(abs "$2")
R=${3:-$(mktemp -d)}
mkdir -p "$R"
cd "$R" || exit 1
PUBLISHED=2.4.0-beta.24
step() { printf '\n=== %s\n' "$*"; }
redact() { sed -e "s#$R#<scratch>#g" -e "s#$HOME#~#g"; }

for v in 10.9.7 12.2.3; do
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
# The project the installer is started from: its own node_modules/.bin/node (what the npm package `node` installs).
mkdir -p "$R/proj/node_modules/.bin"
printf '{"name":"some-project","version":"1.0.0"}\n' > "$R/proj/package.json"
printf '#!/bin/sh\necho "  [the project'"'"'s own node ran: $*]"\n' > "$R/proj/node_modules/.bin/node"; chmod +x "$R/proj/node_modules/.bin/node"
with() { local v=$1 prefix=$2; shift 2; printf 'prefix=%s\n' "$prefix" > "$R/npmrc-$(basename "$prefix")"
  env -i PATH="$R/bin-$v:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$R/home" AGEND_HOME="$R/home/.agend" \
  npm_config_userconfig="$R/npmrc-$(basename "$prefix")" npm_config_cache="$R/cache" npm_config_update_notifier=false \
  npm_config_fund=false npm_config_audit=false LANG=C.UTF-8 AGEND_VERSION="$PUBLISHED" "$@"; }
agend_version() { if [ -x "$1/bin/agend" ]; then env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$R/home" "$1/bin/agend" --version 2>&1; else echo "  (nothing installed at <prefix>/bin/agend)"; fi; }
installer_step() { awk '/^# >>> agend-installer step/{on=1;next} /^# <<< agend-installer step/{on=0} on' "$1"; }
helpers() { grep -E '^(RED|GREEN|YELLOW|NC)=|^(info|warn|error)\(\)' "$1"; }

{
step "versions"; for v in 10.9.7 12.2.3; do echo "npm $(with $v "$R/p-v" npm --version) on node $(node --version)"; done

step "1. The hazard: npm 12, inside the project, \`npm exec --package @songsid/agend@$PUBLISHED -- agend-install\`"
rm -rf "$R/home/.agend"
(cd "$R/proj" && with 12.2.3 "$R/p-hazard" npm exec --yes --package "@songsid/agend@$PUBLISHED" -- agend-install --help 2>&1 | grep -v "^npm notice" | head -3)
agend_version "$R/p-hazard"

for v in 12.2.3 10.9.7; do
  for which in before after; do
    sh_file=$SH_BEFORE; [ "$which" = after ] && sh_file=$SH_AFTER
    step "2. install.sh's installer step, $which, started inside the project, npm $v"
    rm -rf "$R/home/.agend"; P="$R/p-$which-$v"
    (cd "$R/proj" && with "$v" "$P" bash -c "set -euo pipefail
$(helpers "$sh_file")
SUDO=''
$(installer_step "$sh_file")
echo '  (the step finished)'" 2>&1 | grep -E "project's own node|✓|✗|AgEnD v|step finished|error" | head -6)
    agend_version "$P"
  done
done
} 2>&1 | redact
