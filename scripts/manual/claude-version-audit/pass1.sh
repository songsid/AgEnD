#!/bin/bash
# 2.1.294 audit, first pass, as run (commands from the session log; paths parameterised, read-only inspection lines kept).
# Prerequisites: AUDIT_DIR holding the two binaries named 2.1.292 / 2.1.294 (see README.md); run from anywhere.
set -u; . "$(dirname "$0")/lib.sh"

# step 1: mock API up; record the live tmux sessions to diff afterwards; fresh onboarding (o = no key)
cd $A; MOCK_LOG=$A/requests.log setsid python3 $HERE/mockapi.py $PORT > $A/mock.out 2>&1 < /dev/null & sleep 1; ss -ltnp 2>/dev/null | grep $PORT | head -2; tmux list-sessions -F '#{session_name}' 2>/dev/null | sort > $A/tmux-before.txt
for v in $OLD $NEW; do start o$v 2.1.$v $A/h/o$v $A/w/o$v; done; sleep 6; step o 01-first-run 0; show 01-first-run 20

# step 3: theme accepted, then the OAuth URL screen
step o 02-after-theme 3 Enter; show 02-after-theme 14; step o 03-oauth-url 4 Enter; show 03-oauth-url 14; cat $A/cap/diff-03-oauth-url.txt | head -6; for v in $OLD $NEW; do kill1 o$v; done

# step 4: k = API-key home: theme, API-key dialog (Up selects Yes)
for v in $OLD $NEW; do kill1 k$v; rm -rf "${A:?}"/h/k$v; WITHKEY=1 start k$v 2.1.$v $A/h/k$v $A/w/k$v; done; sleep 8; step k 10-key-theme 0; step k 11-key-after-theme 3 Enter; show 11-key-after-theme 14; step k 12-key-after-yes 3 Up Enter; show 12-key-after-yes 14

# step 5: security notes, trust, slash suggestions
step k 13-next 3 Enter; show 13-next 16; step k 14-after-trust 4 Enter; show 14-after-trust 14; step k 15-slash-suggest 2 "/"; show 15-slash-suggest 10; keys k$OLD Escape; keys k$NEW Escape

# step 7: ky = a post-onboarding, key-approved home with bypass consent recorded; then the production writeConfig + buildCommand.
# (As run, ky was a copy of the 2.1.291 audit's home in that same state; this line builds it from k instead.)
for v in $OLD $NEW; do rm -rf "${A:?}"/h/ky$v; cp -a $A/h/k$v $A/h/ky$v; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/ky$v/.claude/settings.json; gencmd $v p; head -c 300 $A/cmd-p$v.txt; echo; done

# step 8: production launch
for v in $OLD $NEW; do kill1 p$v; startcmd p$v $A/h/ky$v $A/w/p$v $A/cmd-p$v.txt; done; sleep 10; step p 20-prod-ready 0; show 20-prod-ready 30; cat $A/cap/diff-20-prod-ready.txt | head

# step 9: a paste, then Enter
for v in $OLD $NEW; do paste p$v "hello from the audit"; done; step p 21-pasted 1; show 21-pasted 12 | tail -6; step p 22-after-turn 4 Enter; show 22-after-turn 20 | tail -10; cat $A/cap/diff-22-after-turn.txt | head -10

# step 10: busy (SLOW), a paste while busy, Enter = native queue (#1169)
grep -n "SLOW" -A3 $HERE/mockapi.py | head -6; for v in $OLD $NEW; do paste p$v "SLOW turn please"; keys p$v Enter; done; sleep 2; step p 23-busy 0; show 23-busy 30 | tail -8; for v in $OLD $NEW; do paste p$v "queued while busy MARKQ"; done; step p 24-busy-pasted 1; show 24-busy-pasted 30 | tail -8; step p 25-busy-queued 2 Enter; show 25-busy-queued 30 | tail -10

# step 11: queue drained; transcript enqueue/dequeue
sleep 30; step p 26-after-queue 0; show 26-after-queue 40 | tail -14; for v in $OLD $NEW; do f=$(ls -t $A/h/ky$v/.claude/projects/*/*.jsonl | head -1); echo "== $v $f"; python3 -I -c "
import json,sys
for line in open(sys.argv[1]):
    d=json.loads(line)
    t=d.get('type'); 
    if t in ('user','queue-operation'):
        m=d.get('message',{}); c=m.get('content') if isinstance(m,dict) else None
        if isinstance(c,list): c=[(x.get('type'), (x.get('text') or '')[:80]) for x in c]
        print(t, d.get('operation'), repr(c if c is not None else d.get('content'))[:160])
" $f; done

# step 12: delivery-envelope paste and a same-words paste (2.1.293 paste fix); transcript records them verbatim
ENV1=$'[agend-delivery-id:11111111-2222-3333-4444-555555555555]\n[from:audit-peer] first line of a multi-line message\nsecond line with detail\nthird line closes it\n(message_id: xmsg-1 | correlation_id: cid-1)'; ENV2=$'same words start this paste\nmiddle line\nend with same words start this paste'; for v in $OLD $NEW; do paste p$v "$ENV1"; done; step p 27-multiline-pasted 1; show 27-multiline-pasted 40 | tail -8; for v in $OLD $NEW; do keys p$v Enter; done; sleep 4; for v in $OLD $NEW; do paste p$v "$ENV2"; done; step p 28-sameword-pasted 1; show 28-sameword-pasted 40 | tail -6; for v in $OLD $NEW; do keys p$v Enter; done; sleep 5; for v in $OLD $NEW; do f=$(ls -t $A/h/ky$v/.claude/projects/*/*.jsonl | head -1); echo "== $v"; python3 -I -c "
import json,sys
for line in open(sys.argv[1]):
    d=json.loads(line)
    if d.get('type')=='user':
        c=d.get('message',{}).get('content'); 
        if isinstance(c,str) and ('agend-delivery' in c or 'same words' in c): print(repr(c[:260]))
" $f; done

# step 13: 429/529/500/401 via the mock: 6 frames each, 3s apart
for e in E429 E529 E500 E401; do for v in $OLD $NEW; do paste p$v "trigger $e now"; keys p$v Enter; done; frames p err-$e 6 3; for v in $OLD $NEW; do keys p$v Escape; done; sleep 2; echo "== $e $NEW last:"; sed '/^\s*$/d' $A/cap/frames/err-$e/$NEW/6.txt | tail -9 | head -5; echo "-- $OLD last:"; sed '/^\s*$/d' $A/cap/frames/err-$e/$OLD/6.txt | tail -9 | head -5; done

# step 14: production resume command
for v in $OLD $NEW; do kill1 p$v; done; for v in $OLD $NEW; do (cd $REPO && HOME=$A/h/ky$v CLAUDE_CONFIG_DIR=$A/h/ky$v/.claude ANTHROPIC_API_KEY=$KEY ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT npx tsx $HERE/gen-cmd.ts $A/inst/p$v $A/w/p$v $A/2.1.$v resume 2>/dev/null > $A/cmd-r$v.txt); grep -o -- "--continue\|--resume[^ ]*" $A/cmd-r$v.txt; startcmd r$v $A/h/ky$v $A/w/p$v $A/cmd-r$v.txt; done; sleep 12; step r 50-resumed 0; show 50-resumed 40 | tail -12

# step 15: production resume with the recorded session id
for v in $OLD $NEW; do kill1 r$v; f=$(ls -t $A/h/ky$v/.claude/projects/*/*.jsonl | head -1); basename $f .jsonl > $A/inst/p$v/session-id; (cd $REPO && HOME=$A/h/ky$v CLAUDE_CONFIG_DIR=$A/h/ky$v/.claude ANTHROPIC_API_KEY=$KEY ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT npx tsx $HERE/gen-cmd.ts $A/inst/p$v $A/w/p$v $A/2.1.$v resume 2>/dev/null > $A/cmd-r$v.txt); grep -o -- "--continue" $A/cmd-r$v.txt; startcmd r$v $A/h/ky$v $A/w/p$v $A/cmd-r$v.txt; done; sleep 12; step r 51-resumed 0; show 51-resumed 60 | tail -14; cat $A/cap/diff-51-resumed.txt | head -10

# step 16: --continue with nothing to continue
for v in $OLD $NEW; do rm -rf "${A:?}"/h/ce$v; cp -a $A/h/ky$v $A/h/ce$v; WITHKEY=1 start ce$v 2.1.$v $A/h/ce$v $A/w/ce$v --continue; done; sleep 8; step ce 52-continue-empty 0; show 52-continue-empty 14; step ce 53-continue-after-trust 5 Up Enter; show 53-continue-after-trust 14; cd $REPO; npx tsx $HERE/classify.ts list $A/cap/$OLD-5[23]* $A/cap/$NEW-5[23]* 2>&1 | cut -c1-160

# step 17: background shell, /exit, the Background work exit prompt (#1217)
for v in $OLD $NEW; do kill1 ce$v; paste r$v "BGWORK start it"; keys r$v Enter; done; sleep 8; step r 60-bg-running 0; show 60-bg-running 60 | tail -8; for v in $OLD $NEW; do keys r$v -l "/exit"; done; sleep 1; step r 61-exit-typed 0; step r 62-bg-exit-dialog 3 Enter; show 62-bg-exit-dialog 60 | tail -12; cd $REPO; npx tsx $HERE/classify.ts list $A/cap/[0-9][0-9][0-9]-6[012]* 2>&1 | cut -c1-200

# step 18: busy without AgEnD's statusLine (esc to interrupt)
for v in $OLD $NEW; do keys r$v Escape; done; for v in $OLD $NEW; do rm -rf "${A:?}"/h/q$v; cp -a $A/h/ky$v $A/h/q$v; WITHKEY=1 start q$v 2.1.$v $A/h/q$v $A/w/p$v --dangerously-skip-permissions; done; sleep 9; for v in $OLD $NEW; do paste q$v "SLOW plain busy"; keys q$v Enter; done; sleep 3; step q 70-busy-nostatusline 0; show 70-busy-nostatusline 60 | tail -6; grep -c "esc to interrupt" $A/cap/$OLD-70-busy-nostatusline.txt $A/cap/$NEW-70-busy-nostatusline.txt; grep -c "esc to interrupt" $A/cap/$OLD-23-busy.txt $A/cap/$NEW-23-busy.txt

# step 19: production first launch on a home with NO bypass consent: AgEnD's --settings carries it, no warning dialog
for v in $OLD $NEW; do kill1 q$v; rm -rf "${A:?}"/h/b$v; cp -a $A/h/k$v $A/h/b$v; (cd $REPO && HOME=$A/h/b$v CLAUDE_CONFIG_DIR=$A/h/b$v/.claude ANTHROPIC_API_KEY=$KEY ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT npx tsx $HERE/gen-cmd.ts $A/inst/b$v $A/w/b$v $A/2.1.$v 2>/dev/null > $A/cmd-b$v.txt); startcmd b$v $A/h/b$v $A/w/b$v $A/cmd-b$v.txt; done; sleep 10; step b 80-prod-first-bypass 0; show 80-prod-first-bypass 20; cd $REPO; npx tsx $HERE/classify.ts list $A/cap/[0-9][0-9][0-9]-80* $A/cap/[0-9][0-9][0-9]-70* 2>&1 | cut -c1-220
