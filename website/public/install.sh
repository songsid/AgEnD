#!/usr/bin/env bash
# AgEnD Bootstrap Installer
# Usage: curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
#
# This script:
# 1. Detects OS + architecture
# 2. Checks/installs Node.js ^22.14.0 || ^23.6.0 || >=24 (via nvm)
# 3. Checks/installs tmux
# 4. Installs agend globally via npm
# 5. Detects backend CLIs
# 6. Runs agend quickstart
#
# Source: https://github.com/songsid/AgEnD/blob/main/website/public/install.sh

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────

# Default SUDO — empty for root, "sudo" for regular users
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}[$1/$TOTAL] $2${NC}"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

TOTAL=5

echo -e "\n${BOLD}═══ AgEnD Installer ═══${NC}\n"

# ── Step 1: Detect OS ────────────────────────────────────

step 1 "Detecting system"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *)      error "Unsupported OS: $OS. AgEnD supports macOS and Linux." ;;
esac

info "$OS_NAME ($ARCH)"

# ── WSL Detection ────────────────────────────────────────

IS_WSL=false
if [ "$OS" = "Linux" ] && grep -qiE "microsoft|WSL" /proc/version 2>/dev/null; then
  IS_WSL=true
  warn "WSL environment detected"

  # Check if node resolves to a Windows binary
  if command_exists node; then
    NODE_BIN_PATH=$(command -v node)
    if [[ "$NODE_BIN_PATH" == /mnt/[a-z]/* ]]; then
      warn "Windows Node.js detected at $NODE_BIN_PATH — this causes issues in WSL"
      warn "Will install a native Linux Node.js via nvm instead"
      # Shadow the Windows node so the version check below triggers nvm install
      node() { return 1; }
      command_exists() { [[ "$1" != "node" ]] && command -v "$1" >/dev/null 2>&1 || return 1; }
    fi
  fi

  echo -e "  ${DIM}Tip: To permanently hide Windows PATH in WSL, add to /etc/wsl.conf:${NC}"
  echo -e "  ${DIM}  [interop]${NC}"
  echo -e "  ${DIM}  appendWindowsPath=false${NC}"
fi

# Detect package manager
PKG_MGR=""
if command_exists brew; then
  PKG_MGR="brew"
elif command_exists apt-get; then
  PKG_MGR="apt"
elif command_exists dnf; then
  PKG_MGR="dnf"
elif command_exists pacman; then
  PKG_MGR="pacman"
fi

# ── Step 2: Node.js ^22.14.0 || ^23.6.0 || >=24 ─────────
# better-sqlite3 v13 uses Node-API 10, available from 22.14.0 / 23.6.0+.

step 2 "Checking Node.js"

NODE_OK=false
# node_version_ok: return 0 when the running Node meets the N-API 10 floor.
node_version_ok() {
  local maj min
  maj=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
  min=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f2)
  [ -z "$maj" ] && return 1
  # 24+: all good
  [ "$maj" -ge 24 ] && return 0
  # 23.6+: good
  [ "$maj" -eq 23 ] && [ "$min" -ge 6 ] && return 0
  # 22.14+: good
  [ "$maj" -eq 22 ] && [ "$min" -ge 14 ] && return 0
  return 1
}
if command_exists node; then
  if node_version_ok; then
    info "Node.js $(node -v) found"
    NODE_OK=true
  else
    warn "Node.js $(node -v) found but ^22.14.0 || ^23.6.0 || >=24 required (N-API 10)"
  fi
fi

if [ "$NODE_OK" = false ]; then
  echo "  Installing Node.js 22 via nvm..."

  # Install nvm if not present
  if [ ! -d "${NVM_DIR:-$HOME/.nvm}" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  nvm install 22
  nvm use 22
  nvm alias default 22

  # Restore command_exists if we shadowed it for WSL
  if [ "$IS_WSL" = true ]; then
    unset -f node 2>/dev/null || true
    unset -f command_exists 2>/dev/null || true
    command_exists() { command -v "$1" >/dev/null 2>&1; }
  fi

  if ! command_exists node; then
    error "Failed to install Node.js. Please install manually: https://nodejs.org"
  fi
  info "Node.js $(node -v) installed via nvm"

  # Ensure nvm loads in login shells (some .bashrc files exit early for non-interactive shells)
  ensure_nvm_in_profile() {
    local profile_file=""
    if [ -f "$HOME/.bash_profile" ]; then
      profile_file="$HOME/.bash_profile"
    elif [ -f "$HOME/.profile" ]; then
      profile_file="$HOME/.profile"
    else
      profile_file="$HOME/.profile"
    fi

    if ! grep -q "NVM_DIR" "$profile_file" 2>/dev/null; then
      cat >> "$profile_file" << 'EOF'

# NVM (added by AgEnD installer)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
EOF
      info "Added nvm to $profile_file for new shell sessions"
    fi
  }
  ensure_nvm_in_profile
fi

# Ensure nvm node is first in PATH on WSL
if [ "$IS_WSL" = true ] && [ -d "${NVM_DIR:-$HOME/.nvm}" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  NODE_BIN_PATH=$(command -v node 2>/dev/null || true)
  if [[ "$NODE_BIN_PATH" == /mnt/[a-z]/* ]]; then
    warn "Windows node still first in PATH — nvm node may not be active"
  fi
fi

# ── Step 3: tmux ─────────────────────────────────────────

step 3 "Checking tmux"

if command_exists tmux; then
  info "tmux $(tmux -V) found"
else
  echo "  Installing tmux..."
  case "$PKG_MGR" in
    brew)   brew install tmux ;;
    apt)    sudo apt-get update -qq && sudo apt-get install -y -qq tmux ;;
    dnf)    sudo dnf install -y tmux ;;
    pacman) sudo pacman -S --noconfirm tmux ;;
    *)      error "Cannot install tmux automatically. Please install manually." ;;
  esac

  if ! command_exists tmux; then
    error "Failed to install tmux."
  fi
  info "tmux $(tmux -V) installed"
fi

# ── Step 4: Install AgEnD ────────────────────────────────

step 4 "Installing AgEnD"

# Ensure build tools are available (needed for native modules like better-sqlite3)
if ! command_exists g++; then
  echo "  Installing build tools (needed for native modules)..."
  echo "  First-time setup can take several minutes. Package-manager progress will be shown below; please wait."
  case "$PKG_MGR" in
    brew)   ;; # macOS Xcode CLT usually provides this
    apt)    $SUDO apt-get update && $SUDO apt-get install -y build-essential python3 ;;
    dnf)    $SUDO dnf groupinstall -y "Development Tools" ;;
    pacman) $SUDO pacman -S --noconfirm base-devel ;;
  esac
fi

if command_exists agend; then
  CURRENT=$(agend --version 2>/dev/null || echo "unknown")
  warn "AgEnD already installed (${CURRENT}), upgrading..."
fi

# Detect if npm global dir needs sudo
# >>> npm-prefix sudo (tests/install-sh-prefix-sudo-2294.test.ts runs this block)
# #2294: a prefix that does not exist yet (for example ~/.npm-global with no lib/)
# is not unwritable. Judge from the nearest existing parent; if that is writable,
# or the prefix is under $HOME, create the missing directories. After that, pick
# sudo from whether lib/node_modules or lib is writable. A writable prefix must
# not override an existing unwritable lib (mkdir -p does not chmod it).
NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "/usr/local")
npm_prefix_existing="$NPM_PREFIX"
while [ ! -e "$npm_prefix_existing" ]; do
  npm_prefix_parent=$(dirname "$npm_prefix_existing")
  [ "$npm_prefix_parent" = "$npm_prefix_existing" ] && break
  npm_prefix_existing="$npm_prefix_parent"
done
npm_prefix_under_home=false
case "$NPM_PREFIX" in
  "$HOME"|"$HOME"/*) npm_prefix_under_home=true ;;
esac
if [ "$npm_prefix_under_home" = true ] || [ -w "$npm_prefix_existing" ]; then
  mkdir -p "$NPM_PREFIX/lib" "$NPM_PREFIX/bin" 2>/dev/null || true
fi
if [ -w "$NPM_PREFIX/lib/node_modules" ] 2>/dev/null || [ -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
  SUDO=""
else
  SUDO="sudo"
fi
# <<< npm-prefix sudo

# Remove old @suzuke/agend if present (bin name conflict)
if npm list -g @suzuke/agend >/dev/null 2>&1; then
  warn "Removing old @suzuke/agend to avoid conflicts..."
  $SUDO npm uninstall -g @suzuke/agend 2>/dev/null || true
  # Remove leftover binary symlink (npm uninstall sometimes leaves it)
  rm -f "$(npm prefix -g)/bin/agend" 2>/dev/null || true
elif command_exists agend; then
  AGEND_REAL=$(readlink -f "$(command -v agend)" 2>/dev/null || true)
  if [[ "$AGEND_REAL" == */AgEnD/* ]] || [[ "$AGEND_REAL" == *"@suzuke/agend"* ]] || [[ "$AGEND_REAL" == */Projects/* ]]; then
    warn "Removing npm-linked @suzuke/agend..."
    AGEND_BIN_DIR=$(dirname "$(command -v agend)")
    $SUDO rm -f "$AGEND_BIN_DIR/agend" "$AGEND_BIN_DIR/agend-agent" 2>/dev/null || true
    NVM_MODULES="$(dirname "$AGEND_BIN_DIR")/lib/node_modules/@suzuke"
    $SUDO rm -rf "$NVM_MODULES" 2>/dev/null || true
  fi
fi

# #2264: install, upgrade and repair are one program — the release's own installer (launcher/agend-install.cjs),
# fetched pinned by npm with its integrity checks. It puts back what an interrupted install moved aside, installs,
# proves `agend --version`, links agend/node into /usr/local/bin for root under nvm, and on a host that already runs
# a fleet sets the service up again. Re-running this one-liner is the repair. AGEND_VERSION picks a version or a
# dist-tag (default: latest; beta: AGEND_VERSION=beta).
# >>> agend-installer step (tests/install-sh-busy-2284.test.ts runs this block)
AGEND_SPEC="@songsid/agend@${AGEND_VERSION:-latest}"
if npm view "$AGEND_SPEC" bin --json 2>/dev/null | grep -q '"agend-install"'; then
  installer_rc=0
  $SUDO npm exec --yes --package "$AGEND_SPEC" -- agend-install || installer_rc=$?
  if [ "$installer_rc" -eq 75 ]; then
    # #2284: the installer could not take the install lock and said why above — most often another AgEnD install that
    # is still running (then: let it finish), sometimes something left behind that it names. Not a failed install.
    case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
      zh*) warn "AgEnD 這次沒有安裝：無法取得安裝鎖（原因見上方）。如果上方說另一個 AgEnD 安裝正在進行，等它完成即可；否則照上方的說明處理，再執行一次這個安裝指令。" ;;
      *) warn "AgEnD was not installed this time: the install lock could not be taken (the reason is above). If it says another AgEnD install is running, let it finish; otherwise do what it says, then run this installer again." ;;
    esac
    exit 75
  elif [ "$installer_rc" -ne 0 ]; then
    error "Installation failed (see above). Run this installer again; it repairs what an interrupted install left."
  fi
else
  # A release from before the installer (this page can be newer than the release it installs).
  $SUDO npm install -g "$AGEND_SPEC" || error "Installation failed. Try: npm install -g $AGEND_SPEC"
fi
# <<< agend-installer step
hash -r 2>/dev/null || true
if ! command_exists agend; then
  error "Installation finished, but \`agend\` is not on PATH. Open a new terminal (or: source ~/.profile)."
fi
info "AgEnD $(agend --version) installed"

# ── Shell completion ───────────────────────────────────────
# bash: static file in bash-completion's completions dir — no rc file touched,
#   idempotent, zero shell-startup cost. Opt out: AGEND_NO_COMPLETION=1
# zsh — and bash where bash-completion is not loaded (#1003: the static file
#   is then never read) — need an rc line, which this non-interactive script
#   only adds when the user explicitly authorizes it with AGEND_MODIFY_RC=1;
#   otherwise agend says exactly what to run.
if [ -z "${AGEND_NO_COMPLETION:-}" ] && command_exists agend; then
  if [ -n "${AGEND_MODIFY_RC:-}" ]; then
    agend completion install --modify-rc || true
  else
    agend completion install || true
  fi
fi

# ── Binaries without nvm sourced: the installer links agend and node into /usr/local/bin for root (#2264);
# kiro-cli is not AgEnD's, so it is linked here.
KIRO_BIN=$(command -v kiro-cli 2>/dev/null || true)
if [ -n "$KIRO_BIN" ] && [[ "$KIRO_BIN" == */.nvm/* ]] && [ "$(id -u)" -eq 0 ]; then
  ln -sf "$KIRO_BIN" /usr/local/bin/kiro-cli 2>/dev/null && info "Symlinked kiro-cli → /usr/local/bin/kiro-cli" || true
fi

# ── Step 5: Detect backend ───────────────────────────────

step 5 "Detecting AI backend"

BACKENDS=("claude:Claude Code" "codex:OpenAI Codex" "muse:Muse" "opencode:OpenCode" "kiro-cli:Kiro CLI" "agy:Antigravity CLI" "grok:Grok Build")
FOUND=0

for entry in "${BACKENDS[@]}"; do
  cmd="${entry%%:*}"
  label="${entry#*:}"
  if command_exists "$cmd"; then
    info "$label found ($cmd)"
    FOUND=$((FOUND + 1))
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo ""
  warn "No supported AI backend found."
  echo -e "  Install Claude Code: ${DIM}curl -fsSL https://claude.ai/install.sh | bash${NC}"
  echo ""
fi

# ── Launch quickstart ─────────────────────────────────────

echo -e "\n${BOLD}═══ Installation Complete ═══${NC}\n"
echo "  Run the setup wizard:"
echo -e "  ${BOLD}agend quickstart${NC}\n"

warn "If 'agend' is not found in a new terminal, run: source ~/.profile"
echo ""

# Auto-launch if interactive terminal
if [ -t 0 ] && [ -t 1 ]; then
  read -rp "  Launch quickstart now? [Y/n] " answer
  if [ "${answer:-Y}" != "n" ] && [ "${answer:-Y}" != "N" ]; then
    echo ""
    agend quickstart
  fi
fi
