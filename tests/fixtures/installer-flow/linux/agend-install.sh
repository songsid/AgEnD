#!/bin/sh
# What songsid.github.io/AgEnD/install.sh leaves behind, for the test: @songsid/agend in npm's global root (with js-yaml,
# which the installer's readiness check loads from it) and `agend` on PATH.
set -e
root=$(npm root -g); pkg=$root/@songsid/agend
mkdir -p "$pkg/node_modules/better-sqlite3"; cp -r /opt/js-yaml "$pkg/node_modules/js-yaml"
# The installer proves SQLite loads: a stand-in with the one call it makes.
echo 'module.exports = class { prepare() { return { get() { return 1; } }; } close() {} };' > "$pkg/node_modules/better-sqlite3/index.js"
echo '{"name":"better-sqlite3","main":"index.js"}' > "$pkg/node_modules/better-sqlite3/package.json"
printf '{"name":"@songsid/agend","version":"%s"}\n' "${AGEND_FAKE_VERSION:-2.3.1}" > "$pkg/package.json"
ln -sf /opt/stubs/agend /usr/local/bin/agend
echo "AgEnD ${AGEND_FAKE_VERSION:-2.3.1} installed"
