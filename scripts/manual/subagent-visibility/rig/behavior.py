import json,re

def mode(root,backend):
 try:return json.loads((root/'modes.json').read_text()).get(backend,'inspect')
 except:return 'inspect'
def user_texts(messages):
 out=[]
 for m in messages:
  if m.get('role')!='user':continue
  c=m.get('content',[])
  if isinstance(c,str):out.append(c)
  else:out.extend(p.get('text','')for p in c if isinstance(p,dict)and p.get('type')in ['text','input_text'])
 return out

def claude(body,seq,root):
 messages=body.get('messages',[]);texts='\n'.join(user_texts(messages));m=mode(root,'claude');tools={t.get('name')for t in body.get('tools',[])}
 plain=lambda text:([{'type':'text','text':text}],'end_turn',0)
 if m=='inspect':return plain('研究資料已準備好。')
 for tag,file in [('CHILD_ONE','marker-one.txt'),('CHILD_TWO','marker-two.txt')]:
  if tag in texts:
   read=any(p.get('type')=='tool_use'and p.get('name')=='Read'for x in messages for p in x.get('content',[])if isinstance(p,dict))
   if not read:return ([{'type':'tool_use','id':f'toolu_{seq}_read','name':'Read','input':{'file_path':str(root/'work'/file)}}],'tool_use',0)
   return ([{'type':'text','text':'已核對範例檔案，內容符合預期。'}],'end_turn',8 if tag=='CHILD_ONE'else 12)
 prior=any(p.get('type')=='tool_use'and p.get('name')=='Agent'for x in messages for p in x.get('content',[])if isinstance(p,dict))
 if not prior and 'Agent'in tools:
  return ([{'type':'tool_use','id':f'toolu_{seq}_{i}','name':'Agent','input':{'description':desc,'subagent_type':typ,'prompt':tag+'：只讀取指定的範例檔案，再回報內容是否符合預期。'}}for i,(tag,typ,desc)in enumerate([('CHILD_ONE','reader','核對第一份範例資料'),('CHILD_TWO','checker','核對第二份範例資料')])],'tool_use',0)
 return plain('兩項範例資料檢查已交辦；請以代理實際回報為準。')

def codex(body,seq,root):
 inp=body.get('input',[]);texts='\n'.join(user_texts(inp));m=mode(root,'codex');plain=lambda text:([{'id':f'msg_{seq}','type':'message','role':'assistant','content':[{'type':'output_text','text':text}]}],0)
 if not body.get('tools')or m=='inspect':return plain('研究資料已準備好。')
 if any(tag in texts for tag in ['CHILD_ONE','CHILD_TWO','THREAD_CHILD']) or any(x.get('name')=='create_thread' and 'THREAD_CHILD' in str(x.get('output','')) and '<codex_delegation>' in str(x.get('output','')) for x in inp):return (plain('已核對範例資料，未發現問題。')[0],8)
 calls=[x for x in inp if x.get('type')=='function_call'];outputs=[x for x in inp if x.get('type')=='function_call_output']
 def call(name,args,namespace):return {'id':f'fc_{seq}_{name}','type':'function_call','call_id':f'call_{seq}_{name}','namespace':namespace,'name':name,'arguments':json.dumps(args,ensure_ascii=False)}
 if m=='threads':
  if not any(x.get('name')=='create_thread'for x in calls):return ([call('create_thread',{'title':'檢查第三份範例資料','prompt':'THREAD_CHILD：只做範例研究並回報，不執行命令或讀取其他檔案。'},'mcp__codex_tui')],0)
  return plain('已建立一項獨立的範例工作。')
 if not any(x.get('name')=='spawn_agent'for x in calls):
  items=[]
  for i,(tag,desc)in enumerate([('CHILD_ONE','核對第一份範例資料'),('CHILD_TWO','核對第二份範例資料')]):
   x=call('spawn_agent',{'message':tag+'：'+desc+'，只回覆研究結果，不執行命令或操作外部資源。','fork_context':False},'multi_agent_v1');x['id']+=str(i);x['call_id']+=str(i);items.append(x)
  return items,0
 ids=[]
 for x in outputs:
  try:
   y=json.loads(x.get('output','{}'));aid=y.get('agent_id')or y.get('id')
   if isinstance(aid,str):ids.append(aid)
  except:pass
 if ids and not any(x.get('name')=='wait_agent'for x in calls):return ([call('wait_agent',{'targets':list(dict.fromkeys(ids)),'timeout_ms':10000},'multi_agent_v1')],0)
 return plain('範例資料檢查已完成，兩位子代理均已回報。')
