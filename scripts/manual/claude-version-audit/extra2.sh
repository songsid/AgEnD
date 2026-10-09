# 2.1.294 audit, third pass: Bash permission prompt (no bypass: --permission-mode default) and the resume-summary menu.
# Run after extra.sh (it reuses extra.sh's xp homes).
set -u; . "$(dirname "$0")/lib.sh"
capb() { for v in $OLD $NEW; do cap $1$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$2.txt; done
  if diff <(norm $A/cap/$OLD-$2.txt) <(norm $A/cap/$NEW-$2.txt) > $A/cap/diff-$2.txt; then echo "[$2] SAME"; else echo "[$2] DIFF ($(wc -l < $A/cap/diff-$2.txt) lines)"; fi; }
for v in $OLD $NEW; do WITHKEY=1 start yp$v 2.1.$v $A/h/xp$v $A/w/xp$v --permission-mode default; done; sleep 6; capb yp 110-default-mode-ready
for v in $OLD $NEW; do paste yp$v "BASHPERM again"; sleep 1; keys yp$v Enter; done; sleep 6; capb yp 111-bash-permission
for v in $OLD $NEW; do keys yp$v Escape; done; sleep 2; capb yp 112-bash-permission-escaped
for v in $OLD $NEW; do kill1 yp$v; done; sleep 1
for v in $OLD $NEW; do python3 $HERE/age-session.py 4 $A/h/xp$v/.claude/projects/*/*.jsonl; done
for v in $OLD $NEW; do WITHKEY=1 start yr$v 2.1.$v $A/h/xp$v $A/w/xp$v --continue; done; sleep 8; capb yr 113-resume-menu
for v in $OLD $NEW; do kill1 yr$v; done
