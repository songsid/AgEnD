#!/bin/sh
# usage: setup.sh <before|after> <port>
V=$1; PORT=$2; E=$(cd "$(dirname "$0")" && pwd); R=/tmp/ag154/$V
rm -rf "$R"; mkdir -p "$R/d/workspaces/a" "$R/home/.local/bin" "$R/home/.grok/bin" "$R/home/.opencode/bin"
cat > "$R/d/fleet.yaml" <<YAML
defaults:
  backend: claude-code
instances:
  master:
    backend: claude-code
    working_directory: $R/d/workspaces/a
health_port: $PORT
web:
  preview: false
YAML
echo '{"completedAt":"2026-11-10T00:00:00.000Z"}' > "$R/d/setup-complete.json"
echo '{"v":1,"epoch":1,"enabled":true,"loopback_only":false,"quick_link":true}' > "$R/d/web-authority.json"
echo 1.5.3 > "$R/home/.agy-version"
cat > "$R/home/.local/bin/agy" <<'SH'
#!/bin/sh
V=$(cat "$HOME/.agy-version")
case "$1" in
  --version|-v|version) echo "$V";;
  models) echo gemini-3-pro;;
  update) echo "Checking for updates..."; sleep 4; echo "Downloading agy 1.6.0 (windows-independent, linux-x64) ..."; sleep 4; echo 1.6.0 > "$HOME/.agy-version"; echo "Updated agy 1.5.3 -> 1.6.0"; sleep 1;;
  *) echo fake agy;;
esac
SH
cat > "$R/home/.local/bin/claude" <<'SH'
#!/bin/sh
case "$1" in --version|-v|version) echo "2.1.319 (Claude Code)";; *) echo fake claude;; esac
SH
cat > "$R/home/.grok/bin/grok" <<'SH'
#!/bin/sh
case "$1" in --version|-v|version) echo "grok 1.0.70 (50ca579fa996)";; *) echo fake grok;; esac
SH
cat > "$R/home/.opencode/bin/opencode" <<'SH'
#!/bin/sh
case "$1" in --version|-v|version) echo "1.18.34";; *) echo fake opencode;; esac
SH
chmod +x "$R"/home/.local/bin/* "$R/home/.grok/bin/grok" "$R/home/.opencode/bin/opencode"
