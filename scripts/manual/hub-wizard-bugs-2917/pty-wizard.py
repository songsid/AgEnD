"""Drive only an owned disposable container; never pass a password in argv or a shell command."""
import argparse,fcntl,json,os,pty,re,select,secrets,signal,struct,subprocess,termios,time
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--container',required=True);ap.add_argument('--tree',choices=['base','candidate'],required=True);ap.add_argument('--out',type=Path,required=True);ap.add_argument('--locale',choices=['en','zh-TW'],default='en');args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
canary='Wizard-'+secrets.token_hex(12)
# Dummy test-fixture credential, read from our copied mock source. Never passed in argv or printed.
password=subprocess.check_output(['docker','exec',args.container,'cat','/opt/fixture/service-password']).decode()
class W:
 def __init__(self,name):
  self.name=name;self.data=b'';self.position=0;self.master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',60,180,0,0))
  self.home='/home/wizard/'+args.tree+'-'+args.locale+'-'+name+'-'+secrets.token_hex(3)
  command=['docker','exec','-it','--user','wizard',args.container,'env','-i','HOME=/home/wizard','USER=wizard','LOGNAME=wizard','PATH=/usr/local/bin:/usr/bin:/bin','TERM=xterm-256color','TZ='+('Asia/Taipei' if args.locale=='zh-TW' else 'UTC'),'AGEND_HOME='+self.home,'HISTFILE=/home/wizard/wizard-history','node','/opt/'+args.tree+'/dist/cli.js','hub','init']
  self.p=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
 def text(self):return ansi.sub('',self.data.decode(errors='replace')).replace('\r','')
 def drain(self,seconds=.05):
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   if select.select([self.master],[],[],max(0,end-time.monotonic()))[0]:
    try:x=os.read(self.master,65536)
    except OSError:break
    if not x:break
    self.data+=x
 def wait(self,pattern,timeout=12):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   self.drain(.05);t=self.text();m=re.search(pattern,t[self.position:])
   if m:self.position+=m.end();return
   if self.p.poll() is not None:raise AssertionError('wizard exited awaiting '+pattern+'\n'+t[-1500:])
  raise AssertionError('prompt timeout '+pattern+'\n'+self.text()[-1500:])
 def answer(self,pattern,value):self.wait(pattern);os.write(self.master,value.encode()+b'\r')
 def prefix(self,to_tls=False):
  for pat,value in [('Hub name|Hub 名稱','Retained setup'),('Web address colleagues|同事要開的網址','https://hub.example.test:18601'),('Member address|機群連線用的成員位址','https://hub.example.test:18602'),('Web listener:|網頁監聽：','127.0.0.1:18601'),('Member listener:|成員監聽：','127.0.0.1:18602')]:self.answer(pat,value)
  self.wait('Certificate file|憑證檔（')
  if to_tls:return
  os.write(self.master,b'/opt/fixture/hub-chain.pem\r');self.answer('private key file|私鑰檔','/opt/fixture/hub.key');self.answer('Directory id|目錄代號','example')
 def directory(self):
  self.answer('Directory address|目錄位址（','ldaps://directory.example.test')
  self.answer('Directory CA:|目錄 CA：','/opt/fixture/ca.pem')
  self.answer('Trust this CA|Trust these|信任.*CA|信任這', 'y')
  self.answer('Directory type|目錄種類','1');self.answer('Where people|人員所在位置','DC=example,DC=test');self.answer('Read-only service account|唯讀服務帳號','CN=Reader,DC=example,DC=test')
 def finish(self):
  self.answer('Service account password|服務帳號密碼（',password)
  self.answer('administrator.s directory login|Your directory login|目錄帳號|第一位管理員', 'alice')
  self.answer('Designate .*administrator|Make .*administrator|要指定 .*Hub 管理員|要讓 .*Hub 管理員','y')
  self.answer('Question and answer content|提問與回答內容','');self.answer('Event records|事件紀錄（','')
  self.answer('Type “initialize”|輸入「initialize」','initialize')
  self.answer('Install AgEnD as a service|現在要把 AgEnD 安裝成服務','no')
  end=time.monotonic()+12
  while self.p.poll() is None and time.monotonic()<end:self.drain(.1)
  assert self.p.poll()==0,('completion',self.p.poll(),self.text()[-1300:])
 def save_close(self):
  self.drain(.15)
  if self.p.poll() is None:
   os.write(self.master,b'\x03');end=time.monotonic()+3
   while self.p.poll() is None and time.monotonic()<end:self.drain(.1)
  if self.p.poll() is None:self.p.terminate()
  try:self.p.wait(timeout=3)
  except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
  self.drain(.05);t=self.text();(args.out/(self.name+'.txt')).write_text(t.replace(canary,'<ECHOED-SECRET-CANARY>').replace(password,'<FIXTURE-PASSWORD>'))
  os.close(self.master)
rows=[]
def scenario(name,fn):
 w=W(name)
 try:result=fn(w);rows.append({'case':name,**result})
 finally:w.save_close()
try:
 def blank(w):
  w.prefix();w.answer('Directory address|目錄位址（','')
  if args.tree=='base':w.wait('Directory CA:|目錄 CA：');return {'bugReproduced':True,'advancedPastEmptyAddress':True}
  w.wait('non-empty LDAPS|目錄位址不可空白');w.answer('Directory address|目錄位址（','ldaps://directory.example.test');w.wait('Directory CA:|目錄 CA：');return {'invalidAddressBlocked':True}
 scenario('empty-address',blank)
 def fingerprint(w):
  w.prefix();w.answer('Directory address|目錄位址（','ldaps://directory.example.test');w.answer('Directory CA:|目錄 CA：','fetch');w.answer('Type the full SHA-256|輸入完整 SHA-256','')
  if args.tree=='base':
   w.wait('fingerprint did not match|指紋不符');end=time.monotonic()+4
   while w.p.poll() is None and time.monotonic()<end:w.drain(.1)
   assert w.p.poll() in (0,1),w.text()[-900:];return {'bugReproduced':True,'exitAfterEnter':w.p.returncode}
  w.wait('earlier answers are kept|已保留先前的答案');w.answer('Directory CA:|目錄 CA：','/opt/fixture/ca.pem');w.wait('Trust this CA|Trust these|信任.*CA|信任這');return {'returnedToCaChoices':True,'previousAnswersKept':True}
 scenario('fingerprint-enter',fingerprint)
 def secret(w):
  w.prefix();w.directory();w.answer('Service password:|Password input method|密碼輸入方式|服務帳號密碼：',canary)
  w.wait('Choose 1|This input was hidden|請選 1|這裡請選');w.drain(.15);visible=canary in w.text()
  assert visible==(args.tree=='base'),('secret echo',visible)
  if args.tree=='candidate':
   w.answer('Password input method|密碼輸入方式','');w.finish();assert canary not in w.text();assert password not in w.text()
   checker = """import json,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]);canary,password=json.load(sys.stdin);files=[p for p in root.rglob('*') if p.is_file()]
secret=root/'hub/secrets/directory-bind'
assert secret.read_text()==password
assert stat.S_IMODE(secret.stat().st_mode)==0o600
assert not any(canary.encode() in p.read_bytes() for p in files)
assert not any(password.encode() in p.read_bytes() for p in files if p!=secret)
for history in [pathlib.Path('/home/wizard/wizard-history'),pathlib.Path('/home/wizard/.bash_history')]:
 if history.exists(): assert canary not in history.read_text() and password not in history.read_text()
print('private-secret-only')
"""
   check=subprocess.check_output(['docker','exec','-i',args.container,'python3','-c',checker,w.home],input=json.dumps([canary,password]).encode()).decode().strip();assert check=='private-secret-only',check
  return {'misplacedSecretEchoed':visible,'completedAfterCorrection':args.tree=='candidate','noSecretInHandoff':args.tree=='candidate','privateSecretOnly':args.tree=='candidate'}
 scenario('secret-method',secret)
 def handoff(w):
  w.prefix();w.directory();w.answer('Service password:|Password input method|密碼輸入方式|服務帳號密碼：','');w.finish();t=w.text();company='Sign in with company account' if args.locale=='en' else '以公司帳號登入';manual='pairing code' if args.locale=='en' else '配對碼';tail=t[t.index('Connecting fleets to this Hub' if args.locale=='en' else '讓機群連上這個 Hub'):]
  if args.tree=='base':assert company not in tail
  else:assert 0<=tail.index(company)<tail.index(manual);assert 'https://hub.example.test:18601/ui/hub' in tail;assert password not in t
  return {'companyJoinLeads':company in tail,'passwordNotEchoed':password not in t}
 scenario('handoff',handoff)
 def tls(w):
  w.prefix(to_tls=True);t=w.text();clear=('company accounts' in t and 'different hostnames' in t and 'browser warning' in t) if args.locale=='en' else all(x in t for x in ['公司帳號連接','不同的主機名稱','瀏覽器略過警告'])
  assert clear==(args.tree=='candidate'),t[-1000:];return {'requirementsBeforeCertificateChoice':clear}
 scenario('certificate-guidance',tls)
finally:
 (args.out/'receipt.json').write_text(json.dumps({'tree':args.tree,'locale':args.locale,'container':args.container,'cases':rows,'realAd':False,'pilot':False,'passwordsInArgv':False,'outputSecretSubstitution':'only the baseline canary and fixture credential if present'},indent=2)+'\n')
print(json.dumps(rows,indent=2))
