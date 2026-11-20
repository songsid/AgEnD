#!/bin/bash
# 2.1.329 audit (M-3477): the trust dialog for a folder that declares hooks. 2.1.329's changelog says the dialog now names
# where the folder's hooks are declared. Fresh homes with the fake key, a workspace whose .claude/settings.json declares a
# SessionStart hook (never trusted, so never run), captured on both versions at 160 and 80 columns.
set -u; . "$(dirname "$0")/lib.sh"
for v in $OLD $NEW; do
  for w in 160 80; do
    n=th$w-$v; home=$A/h/$n; cwd=$A/w/$n
    # pass1's onboarded k home (theme, key and security notes done), so the next screen is this folder's trust dialog.
    rm -rf "${home:?}" "${cwd:?}"; cp -a "$A/h/k$v" "$home"; mkdir -p "$cwd/.claude"
    printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo audit-hook-never-run"}]}]}}\n' > "$cwd/.claude/settings.json"
    WITHKEY=1 start $n 2.1.$v "$home" "$cwd"
    [ "$w" = 80 ] && t resize-window -t $n -x 80 -y 50
  done
done
sleep 10
for v in $OLD $NEW; do for w in 160 80; do cap th$w-$v | sed 's/[[:space:]]*$//' > $A/cap/$v-90-trust-hooks-$w.txt; done; done
for w in 160 80; do
  if diff <(norm $A/cap/$OLD-90-trust-hooks-$w.txt) <(norm $A/cap/$NEW-90-trust-hooks-$w.txt) > $A/cap/diff-90-trust-hooks-$w.txt; then echo "[90-trust-hooks-$w] SAME"; else echo "[90-trust-hooks-$w] DIFF ($(wc -l < $A/cap/diff-90-trust-hooks-$w.txt) lines)"; fi
done
# The hook must not have run (the folder was never trusted).
grep -rl "audit-hook-never-run" $A/h/th*/ 2>/dev/null | head -3
for v in $OLD $NEW; do for w in 160 80; do kill1 th$w-$v; done; done
