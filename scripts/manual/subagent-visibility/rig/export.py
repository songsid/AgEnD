# Captured-campaign extraction, not a general parser. Paths/IDs below deliberately pin this run.
from pathlib import Path
import json,hashlib,re,shutil
root=Path(__file__).resolve().parent;r=root/'r';dst=root.parents[1]/'.worktrees/subagent-visibility/docs/research/subagent-visibility';f=dst/'fixtures';f.mkdir(parents=True,exist_ok=True)
for old in f.glob('*'):old.unlink()
manifest={'capturedAt':'2026-11-09','base':'47106e8d0c3769021e30881b026ff7707747e72f','normalization':'Selected actual records only, no reconstructed events. Drop model/system/developer instructions, API request blobs, environment attachments and gitBranch; preserve message/tool/lifecycle fields. Replace owned absolute paths with $RIG or $CLAUDE_TASK_TMP. Raw SHA binds full original; exported SHA binds selected normalized bytes. No auth headers saved.','files':[]}
def normalize(x):
 s=json.dumps(x,ensure_ascii=False);s=s.replace(str(r),'$RIG').replace(str(root.parents[1]),'$WORKSPACE');s=re.sub(r'/tmp/claude-0/[^/"\\]+/60fe0b33-f528-4141-ab28-208166c3315d',r'$CLAUDE_TASK_TMP/60fe0b33-f528-4141-ab28-208166c3315d',s)
 return json.loads(s)
def save(src,name,rows):
 out=f/name;out.write_text(''.join(json.dumps(normalize(x),ensure_ascii=False,separators=(',',':'))+'\n'for x in rows));manifest['files'].append({'name':name,'rawSource':str(src.relative_to(r)),'rawSha256':hashlib.sha256(src.read_bytes()).hexdigest(),'exportSha256':hashlib.sha256(out.read_bytes()).hexdigest(),'selectedRecords':len(rows)})
cp=next((r/'claude/.claude/projects').glob('*/60fe0*.jsonl'))
for p in [cp,*cp.with_suffix('').joinpath('subagents').glob('*.jsonl')]:
 rows=[]
 for line in p.read_text().splitlines():
  x=json.loads(line);typ=x.get('type');m=x.get('message',{});c=m.get('content',[])
  keep=typ=='system'and x.get('subtype')=='turn_duration' or typ=='assistant'and isinstance(c,list) or typ=='user'and (x.get('toolUseResult')or x.get('origin',{}).get('kind')in ['task-notification','human'] or x.get('isSidechain')and isinstance(c,str))
  if keep:
   x.pop('gitBranch',None);rows.append(x)
 save(p,'claude-parent.jsonl'if p==cp else 'claude-'+p.name,rows)
for p in cp.with_suffix('').joinpath('subagents').glob('*.meta.json'):save(p,'claude-'+p.name,[json.loads(p.read_text())])
for p in (r/'codex3/sessions').rglob('*.jsonl'):
 if any(x in p.name for x in ['01a1bf2d-4a51','01a1bf2d-b386']):continue # exploratory mock-delegation classification attempt, not acceptance
 rows=[]
 for line in p.read_text().splitlines():
  x=json.loads(line);q=x.get('payload',{});typ=q.get('type')
  if x.get('type')=='session_meta':
   x['payload']={k:v for k,v in q.items()if k not in ['base_instructions','git']};rows.append(x)
  elif x.get('type')=='event_msg'and typ in ['task_started','task_complete','turn_aborted','agent_message']:rows.append(x)
  elif x.get('type')=='response_item'and (typ in ['function_call','function_call_output']or typ=='message'and q.get('role')=='assistant'):rows.append(x)
 save(p,'codex-'+p.name,rows)
# Only the relevant advertised tool schemas, not system prompts, auth or unrelated MCP configuration.
for file,backend in [('0004.json','claude'),('0001.json','codex')]:
 p=r/'requests'/file;body=json.loads(p.read_text())['body'];tools=body.get('tools',[])
 selected=[x for x in tools if x.get('name')in ['Agent','multi_agent_v1','mcp__codex_tui']]
 save(p,backend+'-tool-schemas.jsonl',selected)
(dst/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
frames=dst/'panes';frames.mkdir(exist_ok=True)
for name in ['claude-subagents-live.txt','claude-finished.txt','codex-retry-submit.txt','codex-spawn-finished.txt','codex-thread-work.txt','codex-task-approval2.txt','codex-task-created.txt','codex-task2-approval.txt']:
 p=r/'frames'/name
 if p.exists():(frames/name).write_text(p.read_text().replace(str(r),'$RIG'))
print(len(manifest['files']),'files',sum(x['selectedRecords']for x in manifest['files']),'records')
