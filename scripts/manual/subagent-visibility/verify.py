"""Focused research-evidence validation; no CLI/network/product execution."""
from pathlib import Path
import hashlib,json,re
repo=Path(__file__).resolve().parents[3];d=repo/'docs/research/subagent-visibility';f=d/'fixtures';m=json.loads((d/'manifest.json').read_text())
rows={}
for x in m['files']:
 p=f/x['name'];assert hashlib.sha256(p.read_bytes()).hexdigest()==x['exportSha256'],p
 rows[p.name]=[json.loads(s)for s in p.read_text().splitlines()];assert len(rows[p.name])==x['selectedRecords']
assert len(rows)==13 and sum(map(len,rows.values()))==62
parent=rows['claude-parent.jsonl'];launch=[x for x in parent if x.get('toolUseResult',{}).get('status')=='async_launched'];assert len(launch)==2
for x in launch:
 a=x['toolUseResult']['agentId'];child=rows['claude-agent-'+a+'.jsonl'];meta=rows['claude-agent-'+a+'.meta.json'][0]
 assert all(y.get('isSidechain')is True and y.get('agentId')==a and y.get('sessionId')==x['sessionId']for y in child)
 assert meta['toolUseId']==x['message']['content'][0]['tool_use_id'] and meta['finished']is True
 notice=next(y for y in parent if y.get('origin',{}).get('kind')=='task-notification'and f'<task-id>{a}</task-id>'in str(y.get('message',{}).get('content','')))
 text=notice['message']['content'];assert '<status>completed</status>'in text and int(re.search(r'<duration_ms>(\d+)</duration_ms>',text)[1])>0
 assert meta['agentType']in ['reader','checker'] and '<result>已核對範例檔案，內容符合預期。</result>'in text
codex=[v for k,v in rows.items()if k.startswith('codex-rollout')];byid={r[0]['payload']['id']:r for r in codex}
pid='01a1bf2c-0674-7b81-be8e-36e9fc503cc7';pr=byid[pid]
spawns=[x['payload']for x in pr if x.get('payload',{}).get('name')=='spawn_agent'];assert len(spawns)==2
for call in spawns:
 out=next(x['payload']for x in pr if x.get('payload',{}).get('type')=='function_call_output'and x['payload'].get('call_id')==call['call_id'])
 result=json.loads(out['output']);cr=byid[result['agent_id']];cm=cr[0]['payload'];assert cm['parent_thread_id']==pid and cm['session_id']==pid and cm['id']!=pid and cm['thread_source']=='subagent' and cm['agent_nickname']==result['nickname']
 start=next(x['payload']for x in cr if x.get('payload',{}).get('type')=='task_started');finish=next(x['payload']for x in cr if x.get('payload',{}).get('type')=='task_complete');assert start['turn_id']==finish['turn_id'] and finish['duration_ms']>0 and finish['last_agent_message']
 assert start['turn_attribution']['parent_turn_id'] and cm['source']['subagent']['thread_spawn']['depth']==1
refused=byid['01a1bf2c-bb82-7930-840a-1a0dfea70198'];assert any('approval policy is never'in str(x.get('payload',{}).get('output',''))for x in refused)
parentid='01a1bf2f-4617-7843-9ce1-312893cb5957';childid='01a1bf2f-ceb2-7832-a633-ce55586993a7';cr=byid[childid]
assert cr[0]['payload']['thread_source']=='user' and 'parent_thread_id'not in cr[0]['payload']
assert any('create_thread'==x.get('payload',{}).get('name')and '<codex_delegation>'in str(x['payload'].get('output',''))and parentid in str(x['payload']['output'])for x in cr)
assert any(childid in str(x.get('payload',{}).get('output',''))for x in byid[parentid])
assert any(x.get('payload',{}).get('type')=='task_complete'and x['payload']['last_agent_message']for x in cr)
cleanup=json.loads((d/'cleanup.json').read_text());assert cleanup['controller']=={'tmuxClosed':True,'serverClosed':True} and cleanup['socketListening']is False and len(cleanup['daemons'])==4 and not any(x['stillOwnedProcess']for x in cleanup['daemons'])
ready=json.loads((d/'ready.json').read_text());assert ready['routes']==[] and len(ready['interfaces'])==1 and ready['interfaces'][0]['ifname']=='lo'
receipt=json.loads((d/'screenshots/receipt.json').read_text());assert len(receipt['cases'])==4 and not any(x['overflow']for x in receipt['cases'])
for p in (d/'screenshots').glob('*.png'):assert p.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
print('PASS:13files/62actualrecords;2Claude+2Codexchildbindings/finishes;refused+approvedindependenttask;cleanup;4viewportcases')
