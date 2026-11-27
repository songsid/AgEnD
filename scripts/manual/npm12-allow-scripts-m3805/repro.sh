#!/usr/bin/env bash
# M-3805: reproduce npm 12 skipping AgEnD's install scripts, and prove the fix, with REAL npm 10, 11 and 12 on scratch
# prefixes. Never touches the host's global npm, its live install, or a fleet: every install goes to $R/p-*, with
# HOME and AGEND_HOME under $R, and the installer sees only its own process ancestry (no other npm on the host).
#
#   scripts/manual/npm12-allow-scripts-m3805/repro.sh <candidate.tgz> [scratch dir]
#
# The candidate is `npm pack` of this branch (built), its version set to 2.4.0-m3805.1 so it is never mistaken for a
# release. Needs the network (registry.npmjs.org): the published 2.4.0-beta.24 and the bundled Node package.
# Output: one log; scratch paths are printed as <scratch>.
set -uo pipefail
CAND=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
R=${2:-$(mktemp -d)}
mkdir -p "$R"
# Not inside a checkout: `npm exec` in a folder whose package.json is @songsid/agend runs THAT package's bin instead.
cd "$R" || exit 1
PUBLISHED=2.4.0-beta.24
step() { printf '\n=== %s\n' "$*"; }
redact() { sed -e "s#$R#<scratch>#g" -e "s#$HOME#~#g"; }

for v in 10.9.7 11.21.3 12.2.3; do
  [ -x "$R/npm-$v/node_modules/.bin/npm" ] || npm install --prefix "$R/npm-$v" "npm@$v" --no-audit --no-fund >/dev/null 2>&1
  mkdir -p "$R/bin-$v"
  ln -sf "$R/npm-$v/node_modules/.bin/npm" "$R/bin-$v/npm"
  # Only the caller's own ancestry: the installer's "is another npm changing packages?" check judges this run alone.
  cat > "$R/bin-$v/ps" <<'PS'
#!/bin/sh
/bin/ps -A -o pid=,ppid=,args= | awk -v start=$PPID '{ parent[$1] = $2; line[$1] = $0 } END { p = start; while (p > 1 && (p in line) && !(p in seen)) { seen[p] = 1; print line[p]; p = parent[p] } }'
PS
  chmod +x "$R/bin-$v/ps"
done
mkdir -p "$R/home"
# Run with npm <v> first on PATH, a scratch HOME/AGEND_HOME/cache, and nothing of the caller's npm settings.
with() { local v=$1; shift; env -i PATH="$R/bin-$v:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$R/home" AGEND_HOME="$R/home/.agend" \
  npm_config_cache="$R/cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false LANG=C.UTF-8 "$@"; }
installs() { grep -E "install-scripts|added|changed|ERR|error" | grep -v deprecated; }
agend_version() { with "$1" "$2/bin/agend" --version 2>&1; echo "(exit $?)"; }

{
step "versions"; for v in 10.9.7 11.21.3 12.2.3; do echo "npm $(with $v npm --version) on node $(node --version)"; done

step "1. BEFORE: npm 12, plain \`npm install -g @songsid/agend@$PUBLISHED\` (the published release)"
with 12.2.3 npm install -g --prefix "$R/p-before" "@songsid/agend@$PUBLISHED" 2>&1 | installs
agend_version 12.2.3 "$R/p-before"

step "2. AFTER, the launcher: npm 12, plain install of the candidate (scripts still blocked: a plain npm install is the person's)"
with 12.2.3 npm install -g --prefix "$R/p-plain" "$CAND" 2>&1 | installs
agend_version 12.2.3 "$R/p-plain"
echo "--- and with no node on PATH (the sh bin decides alone):"
env -i PATH=/usr/bin:/bin HOME="$R/home" "$R/p-plain/bin/agend" --version 2>&1; echo "(exit $?)"

step "3. The printed repair, as printed (form), run on npm 12 over the broken install from step 1"
with 12.2.3 npm install -g --prefix "$R/p-before" --allow-scripts=@songsid/agend "@songsid/agend@$PUBLISHED" 2>&1 | installs
agend_version 12.2.3 "$R/p-before"

for v in 12.2.3 11.21.3 10.9.7; do
  step "4. AFTER, the release's own installer (what agend update, the Hub update and install.sh run), npm $v, no allow-scripts set anywhere"
  rm -rf "$R/home/.agend"
  with "$v" env npm_config_prefix="$R/p-installer-$v" npm exec --yes --package "$CAND" -- agend-install --spec "$CAND" 2>&1 | grep -E "✓|✗|install-scripts|AgEnD v|error" | head -8
  agend_version "$v" "$R/p-installer-$v"
done

step "4b. BEFORE vs AFTER for a release's installer that does not pass the flag itself (published $PUBLISHED), npm 12"
echo "--- as today's agend update / install.sh start it (no variable):"
rm -rf "$R/home/.agend"
with 12.2.3 env npm_config_prefix="$R/p-old-installer" npm exec --yes --package "@songsid/agend@$PUBLISHED" -- agend-install 2>&1 | grep -E "✓|✗|install-scripts.*blocked|AgEnD v" | head -6
agend_version 12.2.3 "$R/p-old-installer"
echo "--- as this branch's agend update / install.sh start it (npm_config_allow_scripts=@songsid/agend):"
rm -rf "$R/home/.agend"
with 12.2.3 env npm_config_prefix="$R/p-old-installer-env" npm_config_allow_scripts=@songsid/agend npm exec --yes --package "@songsid/agend@$PUBLISHED" -- agend-install 2>&1 | grep -E "✓|✗|install-scripts.*blocked|AgEnD v" | head -6
agend_version 12.2.3 "$R/p-old-installer-env"

step "5. Why agend update and install.sh set the variable: through npm exec, only the variable reaches the installer"
mkdir -p "$R/probe"
printf '{"name":"m3805-probe","version":"1.0.0","bin":{"m3805-probe":"probe.js"}}\n' > "$R/probe/package.json"
printf '#!/usr/bin/env node\nconsole.log("  installer sees npm_config_allow_scripts=" + process.env.npm_config_allow_scripts);\n' > "$R/probe/probe.js"
chmod +x "$R/probe/probe.js"
for v in 10.9.7 11.21.3 12.2.3; do
  echo "npm $v, variable:"; with "$v" env npm_config_allow_scripts=@songsid/agend npm exec --yes --package "$R/probe" -- m3805-probe 2>&1 | tail -1
  echo "npm $v, flag:"; with "$v" npm exec --yes --allow-scripts=@songsid/agend --package "$R/probe" -- m3805-probe 2>&1 | tail -1
done

step "6. Why ignore-scripts is a pre-flight stop: it overrides the allow list on npm 12"
with 12.2.3 npm install -g --prefix "$R/p-ignore" --ignore-scripts --allow-scripts=@songsid/agend "$CAND" 2>&1 | installs
agend_version 12.2.3 "$R/p-ignore"
} 2>&1 | redact
