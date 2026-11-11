from pathlib import Path
import subprocess, json, hashlib
root=Path.cwd(); out=root/'.artifacts/split-chat-ownership'
cases=[
 ('gap-visible','src/ui/chat-store.js','for (const name of shown()) void openHistory(name);','if (s.current) void openHistory(s.current);','recovers both visible'),
 ('prompt-visible','src/ui/chat-store.js','if (shown().has(p.instance)) changed(p.instance);','if (p.instance === s.current) changed(p.instance);','publishes a prompt'),
 ('focus-owner','src/ui/chat-store.js','close() { visible.delete(owner); if (focused === owner) { focused = null; s.current = null; } },','close() { visible.delete(owner); focused = null; s.current = null; },','recovers both visible'),
 ('cache-visible','src/ui/panel-chat.js','!protectedNames.has(n) &&','true &&','never evicts'),
 ('title-focus','src/ui/panel-chat.js','if (pane?.focused !== false) setTitle(inst?.runtime','setTitle(inst?.runtime','binds each composer'),
 ('escape-focus','src/ui/panel-chat.js','paneNow.current?.focused === false || e.key !== "Escape"','e.key !== "Escape"','routes Escape'),
 ('composer-owner','src/ui/panel-chat.js','composers.get(name)?.input.current || null','document.getElementById("msgIn")','binds each composer'),
 ('preview-owner','src/ui/shared/preview-panel.js','if (state.open?.instance === name) closePanel();','closePanel();',"leaving A cannot close"),
 ('image-host','src/ui/image-lightbox.js','const mine = !owner || owner.current?.contains(open?.opener);','const mine = true;',"has one image host"),
 ('details-guards','src/ui/agent-details-settings.js','pane?.addLeaveGuard || routing.addLeaveGuard || setLeaveGuard','setLeaveGuard',"keeps two staged Details"),
 ('history-generation','src/ui/chat-store.js','if (!current()) return false;','',"an old aborted read"),
 ('lazy-hosts','src/ui/shared/app-shell.js','entry.loading.then(() => { if (current) force(n => n + 1); });','const first = !entry.waited; entry.waited = true; entry.loading.then(() => { if (current && first) force(n => n + 1); });','notifies every outlet'),
 ('composer-ids','src/ui/shared/chat-composer.js','ids.msgIn || "msgIn"','"msgIn"',"binds each composer"),
]
results=[]; inputs={}
for name,file,old,new,pattern in cases:
 p=root/file; original=p.read_text(); assert old in original,(name,old)
 inputs.setdefault(hashlib.sha256(original.encode()).hexdigest(),[]).append(file)
 try:
  p.write_text(original.replace(old,new))
  r=subprocess.run(['npx','--no-install','vitest','run','--maxWorkers=1','tests/web-chat-pane-ownership-3637.test.ts','-t',pattern],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  (out/f'mutant-{name}.log').write_text(r.stdout)
  caught=r.returncode!=0 and 'AssertionError' in r.stdout
  results.append({'name':name,'file':file,'pattern':pattern,'exit':r.returncode,'assertionCaught':caught})
  print(name, 'ASSERTION-CAUGHT' if caught else 'NOT-CAUGHT',flush=True)
 finally:p.write_text(original)
(out/'mutations.json').write_text(json.dumps({'inputs':inputs,'results':results},indent=2)+'\n')
assert all(r['assertionCaught'] for r in results),results
