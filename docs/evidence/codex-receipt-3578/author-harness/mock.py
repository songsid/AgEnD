import json,time,threading,runpy
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
ROOT=None
LOCK=threading.Lock();SEQ=0
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*a):pass
 def js(self,value,status=200):
  raw=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):self.js({'models':[],'data':[]})
 def do_POST(self):
  global SEQ
  data=self.rfile.read(int(self.headers.get('content-length','0')));body=json.loads(data or '{}')
  with LOCK:SEQ+=1;seq=SEQ
  (ROOT/'requests'/f'{seq:04d}.json').write_text(json.dumps({'at':time.time(),'path':self.path,'body':body},ensure_ascii=False,indent=2))
  if 'count_tokens' in self.path:return self.js({'input_tokens':100})
  if '/messages' in self.path:return self.claude(body,seq)
  if '/responses' in self.path:return self.codex(body,seq)
  return self.js({})
 def sse(self):
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Cache-Control','no-cache');self.send_header('Connection','close');self.end_headers();self.close_connection=True
 def event(self,kind,data):self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(data,ensure_ascii=False)+'\n\n').encode());self.wfile.flush()
 def claude(self,body,seq):
  blocks,stop,delay=runpy.run_path(str(ROOT.parent/'behavior.py'))['claude'](body,seq,ROOT)
  if delay:time.sleep(delay)
  if not body.get('stream'):return self.js({'id':f'msg_{seq}','type':'message','role':'assistant','model':body.get('model'),'content':blocks,'stop_reason':stop,'stop_sequence':None,'usage':{'input_tokens':50,'output_tokens':10}})
  self.sse();self.event('message_start',{'type':'message_start','message':{'id':f'msg_{seq}','type':'message','role':'assistant','model':body.get('model'),'content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':50,'output_tokens':1}}})
  for i,b in enumerate(blocks):
   if b['type']=='text':
    self.event('content_block_start',{'type':'content_block_start','index':i,'content_block':{'type':'text','text':''}});self.event('content_block_delta',{'type':'content_block_delta','index':i,'delta':{'type':'text_delta','text':b['text']}})
   else:
    self.event('content_block_start',{'type':'content_block_start','index':i,'content_block':{**b,'input':{}}});self.event('content_block_delta',{'type':'content_block_delta','index':i,'delta':{'type':'input_json_delta','partial_json':json.dumps(b['input'])}})
   self.event('content_block_stop',{'type':'content_block_stop','index':i})
  self.event('message_delta',{'type':'message_delta','delta':{'stop_reason':stop,'stop_sequence':None},'usage':{'output_tokens':10}});self.event('message_stop',{'type':'message_stop'})
 def codex(self,body,seq):
  items,delay=runpy.run_path(str(ROOT.parent/'behavior.py'))['codex'](body,seq,ROOT)
  if delay:time.sleep(delay)
  self.sse();self.event('response.created',{'type':'response.created','response':{'id':f'resp_{seq}'}})
  for item in items:self.event('response.output_item.done',{'type':'response.output_item.done','item':item})
  self.event('response.completed',{'type':'response.completed','response':{'id':f'resp_{seq}','usage':{'input_tokens':50,'output_tokens':10,'total_tokens':60}}})

def serve(root):
 global ROOT,SEQ
 ROOT=root;SEQ=max([int(p.stem)for p in (root/'requests').glob('*.json')]+[0]);(root/'requests').mkdir(exist_ok=True);server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();return server
