"""Serial R3 content/header/owner reversals; each must compile and fail assertions."""
from pathlib import Path
import hashlib,json,os,subprocess,sys
root=Path(__file__).resolve().parents[4];out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
git=lambda *a:subprocess.check_output(['git',*a],cwd=root,text=True).strip()
r={'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'runner':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'cases':[]}
cases=[
 ('header-return','src/ui/panel-details.js', [('inst=${null} />${backLink()}</div>','inst=${null} /></div>'),('<${Menu} items=${items} label=${t("app.more")} /></${PanelHeader}>','<${Menu} items=${items} label=${t("app.more")} />${backLink()}</${PanelHeader}>')]),
 ('header-navigates','src/ui/chat-workspace.js',[('onClick=${() => pane.controller.closePane(pane.id)}','onClick=${() => pane.navigate("/ui/chat/"+encodeURIComponent(pane.name))}')]),
 ('wrong-target','src/ui/panel-details.js',[('pane.navigate(backToChat.path);','pane.navigate(chatPath(pane.controller.current()[pane.id === "a" ? "b" : "a"].route.instance));')]),
 ('modified-click','src/ui/panel-details.js',[(' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey','')]),
 ('index-return','src/ui/agent-details-settings.js',[('${children}<div class="s-nav-groups">','<div class="s-nav-groups">')]),
]
for label,path,replacements in cases:
 assert os.getloadavg()[0]<=10
 p=root/path;original=p.read_bytes();assert original==subprocess.check_output(['git','show','HEAD:'+path],cwd=root)
 text=original.decode()
 for before,after in replacements:assert text.count(before)==1,(label,before);text=text.replace(before,after,1)
 try:
  p.write_text(text);subprocess.run(['node','--check',str(p)],cwd=root,check=True,capture_output=True)
  done=subprocess.run(['npx','vitest','run','tests/web-agent-back-chat-3714.test.ts','--maxWorkers=1'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/(label+'.log')).write_text(done.stdout);caught=done.returncode!=0 and 'AssertionError' in done.stdout and 'Transform failed' not in done.stdout and 'ReferenceError' not in done.stdout
  r['cases'].append({'label':label,'exit':done.returncode,'assertionCaught':caught});print(label,done.returncode,caught,flush=True)
 finally:
  p.write_bytes(original);assert p.read_bytes()==original;(out/'receipt.json').write_text(json.dumps(r,indent=2)+'\n')
assert len(r['cases'])==5 and all(x['assertionCaught'] for x in r['cases'])
