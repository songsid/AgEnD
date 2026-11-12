import pathlib, subprocess, json, hashlib, sys
root=pathlib.Path(__file__).resolve().parents[3]
out=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root/'.artifacts/popout-mutations-final'
out.mkdir(parents=True,exist_ok=True)
git=lambda *args: subprocess.check_output(['git',*args],cwd=root,text=True).strip()
receipt={'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'inputs':{},'cases':[]}
cases=[]
def case(label,path,old,new,test): cases.append((label,path,old,new,test))
transport='src/ui/chat-popout-transport.js';store='src/ui/chat-store.js';ui='src/ui/chat-popout.js'
pt='tests/web-chat-popout-transport-3637.test.ts';pd='tests/web-chat-popout-draft-3637.test.ts';pc='tests/web-chat-popout-composition-3637.test.ts'
case('parent-origin',transport,'event.origin !== origin || !valid(event.data)','!valid(event.data)',pt)
case('parent-window',transport,'event.source !== child || ','',pt)
case('viewer-scope',transport,'data.name !== name || data.scope !== scope','data.name !== name',pt)
case('nonce',transport,'offered && data.nonce === nonce &&','offered &&',pt)
case('one-use-ack',transport,'        finish();\n        let completed','        let completed',pt)
case('parent-detach',transport,'try { if (child) child.opener = null; } catch { /* a navigated window may no longer be same-origin */ }','',pt)
case('child-detach',transport,'win.opener = null;','void 0;',pt)
case('deadline',transport,'now() < started + POPOUT_DEADLINE_MS','now() <= started + POPOUT_DEADLINE_MS',pt)
case('child-window',transport,'event.source !== parent || ','',pt)
case('child-current',transport,'const allowed = time() && current() && ready();','const allowed = time() && ready();',pt)
case('child-ready',transport,'const allowed = time() && current() && ready();','const allowed = time() && current();',pt)
case('draft-version',store,'ticket.version === (draftVersions.get(ticket.name) || 0)','true',pd)
case('ticket-owner',store,'draftTickets.has(ticket) &&','true &&',pd)
case('bounded-shape',store,'Object.keys(data).sort().join(",") !== "files,reply,text" || ','',pd)
case('child-occupied',store,'|| (s.drafts[name] || "") || (s.pendingFiles[name] || []).length || s.replies[name]','',pd)
case('file-brand',store,'|| data.files.some(file => typeof File !== "function" || !(file instanceof File))','',pd)
case('source-pane',ui,'alive && controller.current()?.[id] === pane && draft.current()','alive && draft.current()',pc)
case('child-navigation-ticket',ui,'nav.navStore.get() === stamp && stamp.route?.panel === "chat" && stamp.route?.instance === name','nav.navStore.get().route?.panel === "chat" && nav.navStore.get().route?.instance === name',pc)
case('old-css',ui,'&& getComputedStyle(document.documentElement).getPropertyValue("--chat-popout-version").trim() === "1"','',pc)
case('old-store',ui,'&& chat.popoutDraftReady?.() === true','',pc)
case('float-menu-retirement','src/ui/chat-workspace-navigation.js','go({ ...docked, layout,','go({ ...w, layout,','tests/web-chat-workspace-docking-navigation-3637.test.ts')
case('float-dock-retirement','src/ui/shared/chat-workspace-model.js','return { ...docked,','return { ...next,','tests/web-chat-workspace-geometry-3637.test.ts')
case('scoped-width-observer','src/ui/panel-chat.js','return observeComposerWidth(bindings.input.current, () => composers.get(name) === bindings, () => bindings.composing);','return undefined;','tests/web-chat-pane-ownership-3637.test.ts')
case('width-ime','src/ui/panel-chat.js','if (composing()) { deferred = true; return; }','','tests/web-chat-pane-ownership-3637.test.ts')
case('width-height-cap','src/ui/panel-chat.js','Math.min(field.scrollHeight, 240)','field.scrollHeight','tests/web-chat-pane-ownership-3637.test.ts')
case('width-retired-owner','src/ui/panel-chat.js','if (!alive || !current()) return;','if (false) return;','tests/web-chat-pane-ownership-3637.test.ts')

if len(sys.argv)>2:
 selected=set(sys.argv[2].split(',')); cases=[c for c in cases if c[0] in selected]; assert len(cases)==len(selected)
results=[]
for label,path,old,new,test in cases:
 p=root/path; original=p.read_text()
 if old not in original: raise Exception('missing pattern '+label)
 try:
  assert p.read_bytes()==subprocess.check_output(['git','show',f'HEAD:{path}'],cwd=root)
  receipt['inputs'].setdefault(hashlib.sha256(original.encode()).hexdigest(),[]).append(path)
  p.write_text(original.replace(old,new,1))
  subprocess.run(['node','--check',str(p)],check=True,capture_output=True,cwd=root)
  r=subprocess.run(['npx','vitest','run',test,'--maxWorkers=1'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/f'{label}.log').write_text(r.stdout)
  semantic='AssertionError' in r.stdout and 'Transform failed' not in r.stdout
  redundant=label=='float-menu-retirement' and r.returncode==0
  results.append(dict(label=label,path=path,test=test,caught=r.returncode!=0,semantic=semantic,redundant=redundant))
  print(label,r.returncode,'assertion' if semantic else 'OTHER',flush=True)
 finally:
  p.write_text(original); assert p.read_text()==original
  receipt['cases']=results
  (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
if not all((x['caught'] and x['semantic']) or x['redundant'] for x in results): raise SystemExit(1)
