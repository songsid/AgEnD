# 2.1.294 audit, second pass (Prism on #1427): the dialog surfaces the first pass did not capture live.
# Same rig as lib.sh: private tmux socket cc294audit, isolated HOMEs, local mock API on $PORT. Run both versions, diff.
# Run after pass1.sh (it needs pass1's k homes).
set -u; . "$(dirname "$0")/lib.sh"
fresh() { # fresh <name> <ver>: copy of the post-onboarding, key-approved home (no bypass consent, no trusted folders)
  rm -rf "${A:?}/h/$1"; cp -a "$A/h/k$2" "$A/h/$1"; }
capb() { for v in $OLD $NEW; do cap $1$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$2.txt; done
  if diff <(norm $A/cap/$OLD-$2.txt) <(norm $A/cap/$NEW-$2.txt) > $A/cap/diff-$2.txt; then echo "[$2] SAME"; else echo "[$2] DIFF ($(wc -l < $A/cap/diff-$2.txt) lines)"; fi; }
both() { for v in $OLD $NEW; do "$@" $v; done; }

# 1. Bypass Permissions warning (fresh folder: trust first, then the warning)
s1() { fresh xb$1 $1; WITHKEY=1 start xb$1 2.1.$1 $A/h/xb$1 $A/w/xb$1 --dangerously-skip-permissions; }
both s1; sleep 6; capb xb 90-trust-before-bypass
for v in $OLD $NEW; do keys xb$v Down; sleep 1; keys xb$v Enter; done; sleep 4; capb xb 91-bypass-dialog
for v in $OLD $NEW; do keys xb$v Down; done; sleep 1; capb xb 92-bypass-cursor-accept
for v in $OLD $NEW; do keys xb$v Enter; done; sleep 4; capb xb 93-bypass-accepted
for v in $OLD $NEW; do kill1 xb$v; done

# 2. Bash permission prompt (no bypass), then 3. resume menu after a large session
s2() { fresh xp$1 $1; mkdir -p $A/w/xp$1; WITHKEY=1 start xp$1 2.1.$1 $A/h/xp$1 $A/w/xp$1; }
both s2; sleep 6; for v in $OLD $NEW; do keys xp$v Down; sleep 1; keys xp$v Enter; done; sleep 4; capb xp 94-perm-ready
for v in $OLD $NEW; do paste xp$v "BASHPERM go"; sleep 1; keys xp$v Enter; done; sleep 6; capb xp 95-bash-permission
for v in $OLD $NEW; do keys xp$v Escape; done; sleep 3
for v in $OLD $NEW; do paste xp$v "BIG one"; sleep 1; keys xp$v Enter; done; sleep 6; capb xp 96-after-big
for v in $OLD $NEW; do kill1 xp$v; done; sleep 1
s3() { WITHKEY=1 start xr$1 2.1.$1 $A/h/xp$1 $A/w/xp$1 --continue; }
both s3; sleep 8; capb xr 97-resume-menu
for v in $OLD $NEW; do kill1 xr$v; done

# 4. dangerous rm under bypass (consent pre-recorded, as on an AgEnD host)
s4() { fresh xd$1 $1; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/xd$1/.claude/settings.json; WITHKEY=1 start xd$1 2.1.$1 $A/h/xd$1 $A/w/xd$1 --dangerously-skip-permissions; }
both s4; sleep 6; for v in $OLD $NEW; do keys xd$v Down; sleep 1; keys xd$v Enter; done; sleep 4; capb xd 98-bypass-ready
for v in $OLD $NEW; do paste xd$v "DANGER go"; sleep 1; keys xd$v Enter; done; sleep 6; capb xd 99-dangerous-rm
for v in $OLD $NEW; do kill1 xd$v; done

# 5. project .mcp.json approval (fresh folder)
s5() { fresh xm$1 $1; mkdir -p $A/w/xm$1; printf '{"mcpServers":{"probe":{"command":"/bin/true"}}}\n' > $A/w/xm$1/.mcp.json; WITHKEY=1 start xm$1 2.1.$1 $A/h/xm$1 $A/w/xm$1; }
both s5; sleep 6; capb xm 100-mcp-trust
for v in $OLD $NEW; do keys xm$v Down; sleep 1; keys xm$v Enter; done; sleep 4; capb xm 101-mcp-approval
for v in $OLD $NEW; do kill1 xm$v; done

# 6. no credentials at all
s6() { fresh xn$1 $1; start xn$1 2.1.$1 $A/h/xn$1 $A/w/xn$1; }
both s6; sleep 6; for v in $OLD $NEW; do keys xn$v Down; sleep 1; keys xn$v Enter; done; sleep 4; capb xn 102-nologin-start
for v in $OLD $NEW; do paste xn$v "hello"; sleep 1; keys xn$v Enter; done; sleep 5; capb xn 103-nologin-turn
for v in $OLD $NEW; do kill1 xn$v; done
