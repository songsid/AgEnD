# 2.1.327 audit: repeat the dangerous-command menu on each version, keys sent at paint in one burst (atonce), with AgEnD's 200 ms
# gap (gap200), or after a 0.5 s / 1 s wait; print each outcome. A cursor left on No gets one more Enter, as AgEnD's next poll does.
# Run after pass1 (it reuses pass1's k homes). MODES and TRIALS narrow it. Same rig: private tmux socket, isolated HOMEs, local mock.
set -u; . "$(dirname "$0")/lib.sh"
fresh() { rm -rf "${A:?}/h/$1"; cp -a "$A/h/k$2" "$A/h/$1"; }
waitfor() { local s=$1 re=$2 n=$(( $3 * 20 )) i=0; while [ $i -lt $n ]; do cap $s | grep -qE "$re" && return 0; sleep 0.05; i=$((i + 1)); done; return 1; }
trust() { local s=$1 i=0; while [ $i -lt 40 ]; do local p; p=$(cap $s)
    if ! grep -q 'Yes, I trust this folder' <<<"$p"; then return 0; fi
    if grep -qE '❯ No, exit' <<<"$p"; then keys $s Down; elif grep -qE '❯ Yes, I trust this folder' <<<"$p"; then keys $s Enter; fi
    sleep 0.5; i=$((i + 1)); done; return 1; }
outcome() { local p; p=$(cap $1); if grep -q 'Did not run' <<<"$p"; then echo NO-CONFIRMED; elif grep -q '❯ 2. No' <<<"$p"; then echo CURSOR-ON-NO; elif grep -q '❯ 1. Yes' <<<"$p"; then echo CURSOR-ON-YES; elif grep -q 'Ran 1\|tool finished' <<<"$p"; then echo RAN; else echo OTHER; fi; }
for mode in ${MODES:-atonce gap200 delay500 delay1000}; do for trial in $(seq 1 ${TRIALS:-4}); do for v in $OLD $NEW; do
  s=dp$v; kill1 $s; fresh $s $v; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/$s/.claude/settings.json
  WITHKEY=1 start $s 2.1.$v $A/h/$s $A/w/$s --dangerously-skip-permissions; sleep 1; waitfor $s 'trust this folder' 30; trust $s; sleep 3
  paste $s "DANGER go"; sleep 1; keys $s Enter
  if waitfor $s 'Do you want to proceed\?' 20; then
    case $mode in atonce) keys $s Down Enter;; gap200) keys $s Down; sleep 0.2; keys $s Enter;; delay500) sleep 0.5; keys $s Down Enter;; delay1000) sleep 1; keys $s Down Enter;; esac
    sleep 3; o=$(outcome $s); [ $o = CURSOR-ON-NO ] && { keys $s Enter; sleep 2; o="$o then-Enter:$(outcome $s)"; }
  else o=NO-PROMPT; fi
  echo "$mode trial$trial 2.1.$v $o"; kill1 $s
done; done; done
