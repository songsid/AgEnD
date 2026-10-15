#!/usr/bin/env bash
# ═══════════════════════════════════════════
#  AgEnD 離線/線上安裝腳本
#  用法：bash install.sh
#
#  此腳本會：
#  1. 檢查/安裝 Node.js >= 20 (via nvm)
#  2. 檢查/安裝 tmux
#  3. 安裝 agend (npm global)
#  4. 檢查 AI CLI 後端
#  5. 執行 agend quickstart
# ═══════════════════════════════════════════

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}[$1/$TOTAL] $2${NC}"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

TOTAL=5
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\n${BOLD}═══ AgEnD 團隊安裝程式 ═══${NC}\n"
echo -e "  ${DIM}從 Telegram 手機端管理 AI coding agent 團隊${NC}\n"

# ── Step 1: Detect OS ────────────────────────────────────

step 1 "偵測系統環境"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *)      error "不支援的作業系統: $OS。AgEnD 支援 macOS 和 Linux。" ;;
esac

IS_WSL=false
if [ "$OS" = "Linux" ] && grep -qiE "microsoft|WSL" /proc/version 2>/dev/null; then
  IS_WSL=true
  info "$OS_NAME ($ARCH) — WSL 環境"
else
  info "$OS_NAME ($ARCH)"
fi

# Detect package manager
PKG_MGR=""
if command_exists brew; then PKG_MGR="brew"
elif command_exists apt-get; then PKG_MGR="apt"
elif command_exists dnf; then PKG_MGR="dnf"
elif command_exists pacman; then PKG_MGR="pacman"
fi

# ── Step 2: Node.js ^22.14.0 || ^23.6.0 || >=24 ─────────

step 2 "檢查 Node.js (需要 ^22.14.0 || ^23.6.0 || >=24)"

# node_version_ok：22.14+、23.6+、24+ 才符合 N-API 10 要求（better-sqlite3 v13 依賴）
node_version_ok() {
  local maj min
  maj=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
  min=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f2)
  [ -z "$maj" ] && return 1
  [ "$maj" -ge 24 ] && return 0
  [ "$maj" -eq 23 ] && [ "$min" -ge 6 ] && return 0
  [ "$maj" -eq 22 ] && [ "$min" -ge 14 ] && return 0
  return 1
}

NODE_OK=false
if command_exists node; then
  if node_version_ok; then
    info "Node.js $(node -v) 已安裝"
    NODE_OK=true
  else
    warn "Node.js $(node -v) 版本太低，需要 ^22.14.0 || ^23.6.0 || >=24"
  fi
fi

if [ "$NODE_OK" = false ]; then
  echo "  正在安裝 Node.js 22 (via nvm)..."

  if [ ! -d "${NVM_DIR:-$HOME/.nvm}" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  nvm install 22
  nvm use 22
  nvm alias default 22

  if ! command_exists node; then
    error "Node.js 安裝失敗。請手動安裝：https://nodejs.org"
  fi
  info "Node.js $(node -v) 安裝完成"
fi

# ── Step 3: tmux ─────────────────────────────────────────

step 3 "檢查 tmux"

if command_exists tmux; then
  info "tmux $(tmux -V) 已安裝"
else
  echo "  正在安裝 tmux..."
  case "$PKG_MGR" in
    brew)   brew install tmux ;;
    apt)    sudo apt-get update -qq && sudo apt-get install -y -qq tmux ;;
    dnf)    sudo dnf install -y tmux ;;
    pacman) sudo pacman -S --noconfirm tmux ;;
    *)      error "無法自動安裝 tmux，請手動安裝。" ;;
  esac

  if ! command_exists tmux; then
    error "tmux 安裝失敗。"
  fi
  info "tmux $(tmux -V) 安裝完成"
fi

# ── Step 4: Install AgEnD ────────────────────────────────

step 4 "安裝 AgEnD"

# Ensure build tools (needed for better-sqlite3 native module)
if ! command_exists g++ && ! command_exists c++; then
  echo "  安裝編譯工具..."
  case "$PKG_MGR" in
    brew)   ;; # macOS Xcode CLT usually provides this
    apt)    sudo apt-get update -qq && sudo apt-get install -y -qq build-essential python3 ;;
    dnf)    sudo dnf groupinstall -y "Development Tools" ;;
    pacman) sudo pacman -S --noconfirm base-devel ;;
  esac
fi

if command_exists agend; then
  CURRENT=$(agend --version 2>/dev/null || echo "unknown")
  warn "AgEnD 已安裝 (${CURRENT})，升級中..."
fi

# 移除舊版 @suzuke/agend（與 @songsid/agend 的 bin 名稱衝突）
if npm list -g @suzuke/agend >/dev/null 2>&1; then
  warn "移除舊版 @suzuke/agend..."
  $SUDO npm uninstall -g @suzuke/agend 2>/dev/null || true
  rm -f "$(npm prefix -g)/bin/agend" 2>/dev/null || true
fi

# Detect if npm global dir needs sudo
NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "/usr/local")
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if [ ! -w "$NPM_PREFIX/lib/node_modules" ] 2>/dev/null && [ ! -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
    SUDO="sudo"
  fi
fi

$SUDO npm install -g @songsid/agend @songsid/agend-plugin-discord

if ! command_exists agend; then
  error "AgEnD 安裝失敗。請嘗試：sudo npm install -g @songsid/agend"
fi
info "AgEnD $(agend --version) 安裝完成"

# ── Step 5: Detect AI backend ────────────────────────────

step 5 "偵測 AI 後端 CLI"

BACKENDS=("kiro-cli:Kiro CLI" "claude:Claude Code" "codex:OpenAI Codex" "gemini:Gemini CLI" "opencode:OpenCode" "agy:Antigravity CLI")
FOUND=0

for entry in "${BACKENDS[@]}"; do
  cmd="${entry%%:*}"
  label="${entry#*:}"
  if command_exists "$cmd"; then
    info "$label 已安裝 ($cmd)"
    FOUND=$((FOUND + 1))
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo ""
  warn "未偵測到支援的 AI 後端。"
  echo ""
  echo -e "  建議安裝 Kiro CLI："
  echo -e "  ${DIM}curl -fsSL https://cli.kiro.dev/install | bash${NC}"
  echo -e "  安裝後執行：${DIM}kiro-cli login${NC}"
  echo ""
  echo -e "  或安裝 Claude Code："
  echo -e "  ${DIM}curl -fsSL https://claude.ai/install.sh | bash${NC}"
  echo ""
  read -rp "  要現在安裝 Kiro CLI 嗎？[Y/n] " answer
  if [ "${answer:-Y}" != "n" ] && [ "${answer:-Y}" != "N" ]; then
    curl -fsSL https://cli.kiro.dev/install | bash
    echo ""
    echo -e "  ${BOLD}請執行 kiro-cli login 完成認證（用你的 AWS Builder ID）${NC}"
    echo ""
    read -rp "  認證完成後按 Enter 繼續..." _
  fi
fi

# ── Step 5: Launch quickstart ────────────────────────────

echo ""
echo -e "${BOLD}═══ 安裝完成 ═══${NC}"
echo ""
echo "  接下來啟動設定精靈，你需要準備："
echo "  • Telegram Bot Token（跟 @BotFather 建的）"
echo "  • Telegram Group ID（Forum 群組 ID，以 -100 開頭）"
echo "  • 你的 Telegram User ID（跟 @userinfobot 拿的）"
echo ""

if [ -t 0 ] && [ -t 1 ]; then
  read -rp "  準備好了嗎？啟動設定精靈 [Y/n] " answer
  if [ "${answer:-Y}" != "n" ] && [ "${answer:-Y}" != "N" ]; then
    echo ""
    agend quickstart
  else
    echo ""
    echo "  稍後可執行：agend quickstart"
  fi
else
  echo "  請在終端機中執行：agend quickstart"
fi

echo ""
echo -e "${BOLD}═══ 安裝結束 ═══${NC}"
echo ""
echo "  常用指令："
echo "  • agend fleet start   — 啟動 agent 艦隊"
echo "  • agend ls            — 查看 instance 狀態"
echo "  • agend logs          — 查看日誌"
echo "  • agend service install — 設為開機自動啟動"
echo ""
