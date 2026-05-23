#!/usr/bin/env bash
# AgEnD Publish Script
# Usage: ./scripts/publish.sh [patch|minor|major]
# Requires: NPM_TOKEN env var (never stored in repo)
#
# Publishes both @songsid/agend and @songsid/agend-plugin-discord
# Automatically: bumps version, builds, swaps package name, publishes, reverts

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }

# ── Pre-checks ──────────────────────────────────────────────

BUMP="${1:-patch}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  error "Usage: $0 [patch|minor|major]"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Require NPM_TOKEN from environment (never hardcoded)
if [ -z "${NPM_TOKEN:-}" ]; then
  error "NPM_TOKEN env var is required. Export it before running:\n  export NPM_TOKEN=npm_xxxx"
fi

# Ensure clean working tree (no uncommitted changes that could leak secrets)
if [ -n "$(git status --porcelain -- ':!.kiro')" ]; then
  error "Working tree is dirty. Commit or stash changes first."
fi

# Verify tsc passes
info "Type checking..."
npx tsc --noEmit || error "TypeScript compilation failed"

# ── Determine versions ──────────────────────────────────────

CURRENT_VERSION=$(node -p "require('./package.json').version")
# Calculate next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEXT_VERSION="$MAJOR.$MINOR.$PATCH"

echo ""
echo "  Publishing @songsid/agend@${NEXT_VERSION} (bump: ${BUMP})"
echo "  Publishing @songsid/agend-plugin-discord@${NEXT_VERSION}"
echo ""
read -rp "  Confirm? [Y/n] " answer
if [[ "${answer:-Y}" == "n" || "${answer:-Y}" == "N" ]]; then
  echo "Aborted."
  exit 0
fi

# ── Set up temporary .npmrc (avoids global config pollution) ──

TEMP_NPMRC="$REPO_ROOT/.npmrc"
trap 'rm -f "$TEMP_NPMRC"' EXIT
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$TEMP_NPMRC"

# Verify token works
NPM_USER=$(npm whoami --userconfig "$TEMP_NPMRC" 2>/dev/null) || error "npm auth failed. Check NPM_TOKEN."
info "Authenticated as: $NPM_USER"

# ── Publish main package ────────────────────────────────────

info "Building main package..."
npm run build

# Swap name + version for publish
python3 -c "
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
pkg['name'] = '@songsid/agend'
pkg['version'] = '$NEXT_VERSION'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
"

# Verify no secrets in package
if npm pack --dry-run 2>&1 | grep -qiE "\.env|\.npmrc|token|secret|credential"; then
  # Revert before erroring
  git checkout -- package.json
  error "Potential secret detected in package contents!"
fi

npm publish --access public --userconfig "$TEMP_NPMRC"
info "@songsid/agend@${NEXT_VERSION} published"

# Revert main package.json
git checkout -- package.json

# ── Publish Discord plugin ──────────────────────────────────

PLUGIN_DIR="$REPO_ROOT/plugins/agend-plugin-discord"
cd "$PLUGIN_DIR"

info "Building Discord plugin..."
npm run build

# Swap imports in dist from @suzuke to @songsid
sed -i 's|@suzuke/agend|@songsid/agend|g' dist/*.js dist/*.d.ts 2>/dev/null || true

# Swap package.json for publish
python3 -c "
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
pkg['name'] = '@songsid/agend-plugin-discord'
pkg['version'] = '$NEXT_VERSION'
pkg['peerDependencies'] = {'@songsid/agend': '>=${NEXT_VERSION}'}
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
"

npm publish --access public --userconfig "$TEMP_NPMRC"
info "@songsid/agend-plugin-discord@${NEXT_VERSION} published"

# Revert plugin package.json
git checkout -- package.json

cd "$REPO_ROOT"

# ── Done ────────────────────────────────────────────────────

echo ""
info "Published successfully:"
echo "  @songsid/agend@${NEXT_VERSION}"
echo "  @songsid/agend-plugin-discord@${NEXT_VERSION}"
echo ""
echo "  Users update with:"
echo "    npm install -g @songsid/agend@latest @songsid/agend-plugin-discord@latest"
