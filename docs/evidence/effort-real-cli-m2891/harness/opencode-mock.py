import json,time,hashlib
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
root=Path(__file__).parent
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  raw=self.rfile.read(int(self.headers.get('Content-Length','0')));q=json.loads(raw)
  with (root/'out/opencode-requests.jsonl').open('a') as f:f.write(json.dumps({'path':self.path,'model':q.get('model'),'reasoning_effort':q.get('reasoning_effort'),'messages':q.get('messages'),'bodyDigest':hashlib.sha256(raw).hexdigest()})+'\n')
  self.send_response(200);self.send_header('Content-Type','text/event-stream' if q.get('stream') else 'application/json');self.end_headers()
  if q.get('stream'):
   for delta,finish in [({'role':'assistant','content':'offline mock acknowledgement'},None),({},'stop')]:self.wfile.write(('data: '+json.dumps({'id':'audit','object':'chat.completion.chunk','created':1,'model':q['model'],'choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode())
   self.wfile.write(b'data: [DONE]\n\n')
  else:self.wfile.write(json.dumps({'id':'audit','object':'chat.completion','created':1,'model':q['model'],'choices':[{'index':0,'message':{'role':'assistant','content':'offline mock acknowledgement'},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}).encode())
ThreadingHTTPServer(('127.0.0.1',18801),H).serve_forever()
