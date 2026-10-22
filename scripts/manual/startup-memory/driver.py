#!/usr/bin/env python3
"""Real systemd deadlines, controlled memory input; never thrash the host."""
import json, os, pathlib, shlex, shutil, subprocess, time, urllib.request
P = pathlib.Path
ROOT = P('/opt/rehearsal')
HOME = P('/home/rh')
DATA = HOME / 'startup-memory/home'
PREFIX = ROOT / 'prefix'
PKG = PREFIX / 'lib/node_modules/@songsid/agend'
UNIT = 'com.agend.fleet.service'
receipt = {'revision': (ROOT/'revision').read_text().strip(), 'checks': [], 'legs': {}}
mock = None
active_leg = None
leg_cursors = {}

def run(args, timeout=90, ok=True):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if ok and p.returncode: raise RuntimeError(str(args)+': '+p.stdout[-4000:])
    return p

def user(command, timeout=90, ok=True):
    env = f'export AGEND_HOME={DATA} npm_config_prefix={PREFIX} XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus PATH={PREFIX}/bin:/usr/local/bin:/usr/bin:/bin; '
    return run(['su','-','rh','-c',env+command], timeout, ok)

def sd(*args, ok=True): return user('systemctl --user '+' '.join(args), ok=ok)
def state():
    return dict(line.split('=',1) for line in sd('show',UNIT,'-p',
      'MainPID,NRestarts,ActiveState,SubState,Result,Type,NotifyAccess,TimeoutStartUSec,WatchdogUSec,MemoryMax,MemorySwapMax').stdout.splitlines() if '=' in line)

def check(name, condition, details=None):
    receipt['checks'].append({'name':name,'pass':bool(condition),'details':details})
    (ROOT/'results.json').write_text(json.dumps(receipt,indent=2))
    print(('PASS ' if condition else 'FAIL ')+name,flush=True)
    if not condition: raise RuntimeError(name+': '+str(details))

def wait(name, fn, timeout=100):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        try:
            value=fn()
            if value: return value
        except (OSError,ValueError,urllib.error.URLError): pass
        time.sleep(.2)
    raise RuntimeError('Timed out: '+name)

def http(path, data=None):
    req=urllib.request.Request('http://127.0.0.1:18443'+path,
      data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=3) as r: return json.load(r)

def capture(leg):
    cursor = leg_cursors.get(leg)
    boundary = ' --after-cursor='+shlex.quote(cursor) if cursor else ''
    (ROOT/(leg+'-journal.log')).write_text(user('journalctl --user -u '+UNIT+' --no-pager'+boundary,ok=False).stdout)
    if (DATA/'daemon.log').exists(): shutil.copyfile(DATA/'daemon.log',ROOT/(leg+'-daemon.log'))

def begin(mode):
    global active_leg
    active_leg = mode
    sd('stop',UNIT,ok=False); sd('reset-failed',UNIT,ok=False)
    journal = user('journalctl --user -u '+UNIT+' --no-pager -n 1 --show-cursor',ok=False).stdout
    leg_cursors[mode] = journal.split('-- cursor: ',1)[1].strip() if '-- cursor: ' in journal else None
    # The mock reset drains disconnected pollers between service generations.
    http('/control/reset',{})
    (ROOT/'pressure').write_text('critical' if mode!='nonmemory' else 'normal')
    (ROOT/'mode').write_text(mode)
    for name in ['general','sibling']:
        (DATA/'instances'/name/'mock-cli.pid').unlink(missing_ok=True)
    sd('start','--no-block',UNIT)
    return wait('main PID',lambda: (s if int((s:=state()).get('MainPID','0')) else None))

try:
    check('private Docker boundary',P('/.dockerenv').exists() and os.environ.get('AGEND_STARTUP_MEMORY_REHEARSAL')=='1')
    check('outer hard cap and swap disabled',P('/sys/fs/cgroup/memory.max').read_text().strip()=='1610612736'
      and P('/sys/fs/cgroup/memory.swap.max').read_text().strip()=='0')
    check('systemd249',run(['systemd','--version']).stdout.startswith('systemd 249'))
    run(['loginctl','enable-linger','rh']); run(['systemctl','start','user@1000.service'])
    wait('private user manager',lambda:P('/run/user/1000/systemd/private').exists())
    PKG.parent.mkdir(parents=True,exist_ok=True); (PREFIX/'bin').mkdir(parents=True)
    shutil.move(str(ROOT/'pkg'),str(PKG))
    shutil.copytree(PKG/'dist',ROOT/'candidate-dist')
    (PREFIX/'bin/agend').symlink_to(PKG/'launcher/agend')
    DATA.mkdir(parents=True)
    for name in ['general','sibling']: (HOME/'startup-memory/work'/name).mkdir(parents=True)
    config={'channel':{'type':'telegram','mode':'topic','bot_token_env':'AGEND_BOT_TOKEN','group_id':-1001234567890,
      'telegram_api_root':'http://127.0.0.1:18443','access':{'mode':'locked','allowed_users':[111222333]}},
      'defaults':{'backend':'mock','model':'mock-model','startup':{'concurrency':2,'stagger_delay_ms':0},
        'hang_detector':{'enabled':False},'context_guardian':{'grace_period_ms':600000,'max_age_hours':0}},
      'instances':{'general':{'working_directory':str(HOME/'startup-memory/work/general'),'topic_id':42,'general_topic':True},
        'sibling':{'working_directory':str(HOME/'startup-memory/work/sibling'),'topic_id':87}},'health_port':19280}
    (DATA/'fleet.yaml').write_text(json.dumps(config)); (DATA/'.env').write_text('AGEND_BOT_TOKEN=123456:rehearsal\n')
    fixture=PKG/'e2e/mock-servers/mock-claude.mjs'
    source=fixture.read_text().replace('writeStatusline();\nconst statusTimer',
      'writeFileSync(join(INSTANCE_DIR, "mock-cli.pid"), String(process.pid));\nwriteStatusline();\nconst statusTimer',1)
    fixture.write_text(source)
    # This is the only injected boundary: a repeatable pressure reader, or an
    # unrelated never-resolving lifecycle callback. Gate/notifier/CLI are real.
    (ROOT/'bootstrap.mjs').write_text('''
import {readFileSync} from 'node:fs';
if (process.argv[1]?.endsWith('/dist/cli.js') && process.argv.includes('fleet') && process.argv.includes('start')) {
  const {MemoryPressure}=await import('./prefix/lib/node_modules/@songsid/agend/dist/memory-pressure.js');
  const start=MemoryPressure.prototype.start;
  MemoryPressure.prototype.start=function() {
    this.read=()=>({totalBytes:16e9,availableBytes:readFileSync('/opt/rehearsal/pressure','utf8')==='critical'?10e6:8e9,
      availableKind:'available',swapTotalBytes:0,swapFreeBytes:0,linuxPsi:{someAvg60:0,fullAvg10:0}});
    return start.call(this);
  };
  if (readFileSync('/opt/rehearsal/mode','utf8')==='nonmemory') {
    const {InstanceLifecycle}=await import('./prefix/lib/node_modules/@songsid/agend/dist/instance-lifecycle.js');
    const start=InstanceLifecycle.prototype.start;
    InstanceLifecycle.prototype.start=function(name,...args) {
      return name==='general'?new Promise(()=>{}):start.call(this,name,...args);
    };
  }
}
''')
    (ROOT/'telegram-server.mjs').write_text("import {createTelegramMock} from './telegram-mock.mjs'; await createTelegramMock({port:18443}).start();\n")
    run(['chown','-R','rh:rh',str(ROOT),str(HOME/'startup-memory')])
    user(f'node {PKG}/launcher/postinstall.cjs')
    mock=subprocess.Popen(['node',str(ROOT/'telegram-server.mjs')],stdout=open(ROOT/'telegram.log','w'),stderr=subprocess.STDOUT)
    wait('local Telegram mock',lambda:http('/control/calls') is not None)
    user('agend install --no-activate')
    drop=HOME/'.config/systemd/user'/(UNIT+'.d'); drop.mkdir(parents=True,exist_ok=True)
    (drop/'zz-startup-rehearsal.conf').write_text('[Service]\nTimeoutStartSec=8s\nTimeoutStopSec=3s\nRestartSec=1s\nMemoryMax=768M\nMemorySwapMax=0\nEnvironment=NODE_OPTIONS=--import=/opt/rehearsal/bootstrap.mjs\nEnvironment=MOCK_RESPONSE=Mock\\x20sibling\\x20survived\n')
    run(['chown','-R','rh:rh',str(drop)]); sd('daemon-reload')
    loaded=state()
    check('actual loaded persistent notify unit and short deadline',loaded['Type']=='notify' and loaded['NotifyAccess']=='all'
      and loaded['TimeoutStartUSec']=='8s' and loaded['MemoryMax']=='805306368' and loaded['MemorySwapMax']=='0',loaded)
    # Real unmodified baseline dist, same config/reader and real manager.
    shutil.rmtree(PKG/'dist'); shutil.copytree(ROOT/'baseline-dist',PKG/'dist'); run(['chown','-R','rh:rh',str(PKG/'dist')])
    before=begin('baseline')
    looping=wait('baseline timeout loop',lambda:(s if int((s:=state()).get('NRestarts','0'))>=2 else None),timeout=45)
    check('baseline repeats startup timeout/restart',int(looping['NRestarts'])>=2 and looping['MainPID']!=before['MainPID'],[before,looping])
    receipt['legs']['baseline']={'before':before,'after':looping}; sd('stop',UNIT,ok=False); capture('baseline')
    check('baseline journal records two startup timeouts',(ROOT/'baseline-journal.log').read_text().count('start operation timed out')>=2)
    # Candidate remains activating for >2x the original start deadline, then
    # converges with the same fleet PID after pressure clears.
    shutil.rmtree(PKG/'dist'); shutil.copytree(ROOT/'candidate-dist',PKG/'dist'); run(['chown','-R','rh:rh',str(PKG/'dist')])
    before=begin('candidate'); at=time.monotonic(); time.sleep(18)
    held=state()
    check('candidate survives beyond original deadline in same PID',held['MainPID']==before['MainPID'] and held['ActiveState']=='activating'
      and held['NRestarts']==before['NRestarts'],[before,held])
    check('READY withheld while memory deferred',held['SubState']=='start')
    try:
        with urllib.request.urlopen('http://127.0.0.1:19280/ui/poll',timeout=3) as r: status = r.status
    except urllib.error.HTTPError as error: status = error.code
    check('early dashboard responds during memory wait',status in [200,401],status)
    (ROOT/'pressure').write_text('normal')
    after=wait('candidate convergence',lambda:(s if (s:=state()).get('ActiveState')=='active' else None),timeout=100)
    check('candidate converges without a restart',after['MainPID']==before['MainPID'] and after['NRestarts']==before['NRestarts'],after)
    http('/control/reset',{}); http('/control/send-message',{'text':'prove sibling after startup','chat_id':-1001234567890,'thread_id':87,'user_id':111222333})
    def replied():
        value = http('/control/calls')
        rows = value if isinstance(value,list) else value.get('result',value.get('calls'))
        if not isinstance(rows,list): raise TypeError('mock call log is not a list')
        matches = [c for c in rows if c.get('method')=='sendMessage'
          and str(c.get('params',{}).get('chat_id'))=='-1001234567890'
          and str(c.get('params',{}).get('message_thread_id'))=='87'
          and 'Mock sibling survived' in str(c.get('params',{}).get('text',''))]
        if matches: (ROOT/'candidate-replies.json').write_text(json.dumps(matches,indent=2))
        return bool(matches)
    check('sibling answers after pressure release',bool(wait('sibling reply',replied)))
    receipt['legs']['candidate']={'before':before,'held':held,'after':after,'seconds':time.monotonic()-at}
    sd('stop',UNIT,ok=False); capture('candidate')
    check('hold and recovery explained in daemon log','renewing systemd startup timeout' in (ROOT/'candidate-daemon.log').read_text())
    # Negative control: new code does NOT extend an unrelated startup hang.
    before=begin('nonmemory')
    after=wait('nonmemory hang timeout',lambda:(s if int((s:=state()).get('NRestarts','0'))>int(before['NRestarts']) else None),timeout=25)
    check('ordinary startup hang still times out',int(after['NRestarts'])>int(before['NRestarts']),[before,after])
    receipt['legs']['nonmemory']={'before':before,'after':after}; sd('stop',UNIT,ok=False); capture('nonmemory')
    check('nonmemory journal confirms startup timeout','start operation timed out' in (ROOT/'nonmemory-journal.log').read_text())
finally:
    try:
        if active_leg is not None: capture(active_leg)
    except Exception: pass
    try: sd('stop',UNIT,ok=False)
    except Exception: pass
    if mock is not None:
        mock.terminate()
        try: mock.wait(timeout=5)
        except subprocess.TimeoutExpired: mock.kill(); mock.wait()
    (ROOT/'results.json').write_text(json.dumps(receipt,indent=2))
